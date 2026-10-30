import * as fs from 'node:fs';
import type { PromptRecord, SessionInfo } from '../types.js';
import { errorMessage } from '../util/fs.js';
import { scanLines } from '../util/lines.js';
import type { SourceContext, SourceSyncResult } from './base.js';

/** A session held in one file that is re-read whole when it changes (chat logs are small compared to Copilot's). */
export interface SessionFileRead {
	readonly session: SessionInfo;
	readonly prompts: readonly PromptRecord[];
}

interface FileState {
	readonly size: number;
	readonly mtimeMs: number;
	/** Session key the file produced, for deletion. */
	readonly key: string;
	/** Projection version; a bump re-reads every file. */
	readonly v: number;
}

export interface SyncSessionFilesOptions<F extends { readonly path: string }> {
	/** `files` table kind; one per source. */
	readonly kind: string;
	/** Bump when the projection changes so existing indexes re-read every file. */
	readonly version: number;
	readonly files: readonly F[];
	/** Projects one file to a session and its prompts. `undefined` means "nothing to index" (the file is still tracked). */
	readonly read: (file: F, stat: fs.Stats) => SessionFileRead | undefined;
}

/**
 * The sync loop shared by whole-file sources: skip unchanged files (size + mtime + version), replace the prompts of
 * changed ones, and drop sessions whose file disappeared unless `retainDeleted`.
 */
export async function syncSessionFiles<F extends { readonly path: string }>(
	ctx: SourceContext,
	o: SyncSessionFilesOptions<F>,
): Promise<SourceSyncResult> {
	const { store, chunker } = ctx;
	const errors: string[] = [];
	let added = 0;
	let removed = 0;
	let sessionsChanged = false;
	const seen = new Set<string>();
	const states = store.loadFileStates<FileState>(o.kind);
	for (const file of o.files) {
		seen.add(file.path);
		try {
			const st = fs.statSync(file.path);
			const prev = states.get(file.path);
			if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.v === o.version) {
				continue;
			}
			const r = o.read(file, st);
			store.transaction(() => {
				if (r) {
					if (r.prompts.length > 0) {
						store.upsertSession(r.session);
						sessionsChanged = true;
					}
					const [a, d] = store.replaceSessionPrompts(r.session.key, r.prompts, chunker);
					added += a;
					removed += d;
				} else if (prev?.key) {
					removed += store.deleteSession(prev.key);
				}
				store.setFileState(file.path, o.kind, {
					size: st.size,
					mtimeMs: st.mtimeMs,
					key: r?.session.key ?? '',
					v: o.version,
				});
			});
		} catch (e) {
			errors.push(`${file.path}: ${errorMessage(e)}`);
		}
		await ctx.yieldToLoop();
		if (ctx.signal.aborted) {
			return { added, removed, sessionsChanged, errors };
		}
	}
	if (!ctx.retainDeleted) {
		for (const [file, prev] of states) {
			if (!seen.has(file) && !fs.existsSync(file)) {
				removed += store.transaction(() => {
					store.deleteFile(file);
					return prev.key ? store.deleteSession(prev.key) : 0;
				});
			}
		}
	}
	return { added, removed, sessionsChanged, errors };
}

/** Parses every JSON line of a file (lines over `maxLineBytes` are skipped), calling `onEntry` with the object. */
export function forEachJsonLine(
	file: string,
	size: number,
	onEntry: (entry: Record<string, unknown>) => void,
	opts: { readonly wantLine?: (head: string) => boolean; readonly maxLineBytes?: number } = {},
): { readonly badLines: number; readonly oversized: number } {
	let badLines = 0;
	const { oversized } = scanLines(file, {
		start: 0,
		end: size,
		headBytes: 256,
		maxLineBytes: opts.maxLineBytes ?? 8 * 1024 * 1024,
		wantLine: opts.wantLine ?? (() => true),
		onLine: line => {
			let entry: unknown;
			try {
				entry = JSON.parse(line.toString('utf8'));
			} catch {
				badLines++;
				return;
			}
			if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
				onEntry(entry as Record<string, unknown>);
			}
		},
	});
	return { badLines, oversized };
}

/** The first line of a text, trimmed to `max` characters, for titles. */
export function firstLine(text: string, max: number): string {
	const line = text.trim().split(/\r?\n/u, 1)[0] ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Text content of a message whose `content` is a string or an array of `{ type, text }` blocks. */
export function textContent(content: unknown, textTypes: readonly string[]): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.flatMap(block =>
			block &&
			typeof block === 'object' &&
			textTypes.includes(String((block as { type?: unknown }).type)) &&
			typeof (block as { text?: unknown }).text === 'string'
				? [(block as { text: string }).text]
				: [],
		)
		.join('\n');
}

/** `"2026-09-30T10:00:00.000Z"` or epoch ms → epoch ms, else `undefined`. */
export function toEpochMs(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v)) {
		return v;
	}
	if (typeof v === 'string') {
		const t = Date.parse(v);
		return Number.isNaN(t) ? undefined : t;
	}
	return undefined;
}

/** Name of the leading XML-ish tag of an injected message (`<task-notification>` → `task-notification`), if any. */
export function leadingTag(text: string): string | undefined {
	return /^\s*<([a-zA-Z][\w-]*)[\s>]/u.exec(text)?.[1];
}

/** Errors from readers that should be surfaced per file but not stop the sync. */
export function readerError(file: string, badLines: number, oversized: number): string | undefined {
	const parts = [
		badLines ? `${badLines} unparsable line(s)` : '',
		oversized ? `${oversized} oversized line(s) skipped` : '',
	].filter(Boolean);
	return parts.length > 0 ? `${file}: ${parts.join(', ')}` : undefined;
}
