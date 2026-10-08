import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { PromptOrigin, PromptRecord, SessionInfo } from '../types.js';
import { scanLines } from '../util/lines.js';

/** Persisted incremental-read state for one `events.jsonl`. */
export interface CopilotFileState {
	readonly size: number;
	readonly mtimeMs: number;
	/** Byte offset of the next unread line. */
	readonly cursor: number;
	/** Hash of the first `headLen` already-consumed bytes, to detect rewrites/truncation. */
	readonly headHash: string;
	readonly headLen?: number;
	readonly seq: number;
	readonly model?: string;
	readonly startTime?: number;
	readonly cwd?: string;
}

export interface CopilotSessionDir {
	readonly sessionId: string;
	readonly dir: string;
	readonly eventsPath: string;
	readonly yamlPath: string;
}

export function listCopilotSessions(copilotHome: string): CopilotSessionDir[] {
	const root = path.join(copilotHome, 'session-state');
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: CopilotSessionDir[] = [];
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith('.')) {
			continue;
		}
		const dir = path.join(root, e.name);
		out.push({ sessionId: e.name, dir, eventsPath: path.join(dir, 'events.jsonl'), yamlPath: path.join(dir, 'workspace.yaml') });
	}
	return out;
}

export function copilotSessionKey(sessionId: string): string {
	return `copilot:${sessionId}`;
}

const HEAD_HASH_BYTES = 4096;

function headHash(file: string, len: number): string {
	const buf = Buffer.alloc(len);
	const fd = fs.openSync(file, 'r');
	try {
		fs.readSync(fd, buf, 0, len, 0);
	} finally {
		fs.closeSync(fd);
	}
	return createHash('sha1').update(buf).digest('hex');
}

export function classifyCopilotOrigin(data: { source?: unknown; isAutopilotContinuation?: unknown }): PromptOrigin {
	if (data.isAutopilotContinuation === true) {
		return 'autopilot';
	}
	const source = data.source;
	if (source === undefined || source === null || source === '' || source === 'user') {
		return 'human';
	}
	if (typeof source === 'string') {
		if (source.startsWith('skill-')) {
			return 'skill';
		}
		if (source.startsWith('agent-')) {
			return 'agent';
		}
	}
	return 'system';
}

export interface CopilotReadResult {
	readonly state: CopilotFileState;
	/** True when previously indexed prompts for this session must be discarded first. */
	readonly reset: boolean;
	readonly prompts: PromptRecord[];
	readonly oversized: number;
	readonly badLines: number;
}

const WANTED = ['"type":"user.message"', '"type":"session.start"', '"type":"session.model_change"'];

/**
 * Incrementally reads new `user.message` events. Returns `undefined` when the file is unchanged.
 */
export function readCopilotEvents(session: CopilotSessionDir, prev: CopilotFileState | undefined): CopilotReadResult | undefined {
	let st: fs.Stats | undefined;
	try {
		st = fs.statSync(session.eventsPath, { throwIfNoEntry: false });
	} catch {
		return undefined;
	}
	if (!st) {
		return undefined;
	}
	if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
		return undefined;
	}
	const prevHeadLen = prev?.headLen ?? 0;
	const reset = !prev || st.size < prev.cursor || st.size < prevHeadLen
		|| (prevHeadLen > 0 && headHash(session.eventsPath, prevHeadLen) !== prev.headHash);
	const base: CopilotFileState = reset
		? { size: 0, mtimeMs: 0, cursor: 0, headHash: '', headLen: 0, seq: 0 }
		: prev!;

	let seq = base.seq;
	let model = base.model;
	let startTime = base.startTime;
	let cwd = base.cwd;
	let badLines = 0;
	const prompts: PromptRecord[] = [];
	const sessionKey = copilotSessionKey(session.sessionId);

	const { endOffset, oversized } = scanLines(session.eventsPath, {
		start: base.cursor,
		end: st.size,
		wantLine: head => WANTED.some(w => head.includes(w)),
		onLine: (line, offset) => {
			let e: { type?: string; id?: string; timestamp?: string; data?: Record<string, unknown> };
			try {
				e = JSON.parse(line.toString('utf8'));
			} catch {
				badLines++;
				return;
			}
			const data = e.data ?? {};
			switch (e.type) {
				case 'session.start': {
					if (typeof data['selectedModel'] === 'string') {
						model = data['selectedModel'];
					}
					const t = Date.parse(String(data['startTime'] ?? e.timestamp ?? ''));
					if (!Number.isNaN(t)) {
						startTime = t;
					}
					const ctx = data['context'] as { cwd?: unknown } | undefined;
					if (typeof ctx?.cwd === 'string') {
						cwd = ctx.cwd;
					}
					break;
				}
				case 'session.model_change':
					if (typeof data['newModel'] === 'string') {
						model = data['newModel'];
					}
					break;
				case 'user.message': {
					const content = data['content'];
					if (typeof content !== 'string' || content.trim().length === 0) {
						break;
					}
					const ts = Date.parse(e.timestamp ?? '');
					prompts.push({
						id: `${sessionKey}:${e.id ?? `@${offset}`}`,
						sessionKey,
						text: content,
						timestamp: Number.isNaN(ts) ? (startTime ?? st.mtimeMs) : ts,
						origin: classifyCopilotOrigin(data),
						seq: seq++,
						model,
					});
					break;
				}
			}
		},
	});

	const headLen = Math.min(HEAD_HASH_BYTES, endOffset);
	const hh = headLen === base.headLen ? base.headHash : headHash(session.eventsPath, headLen);
	return {
		state: { size: st.size, mtimeMs: st.mtimeMs, cursor: endOffset, headHash: hh, headLen, seq, model, startTime, cwd },
		reset,
		prompts,
		oversized,
		badLines,
	};
}

interface WorkspaceYaml {
	id?: string;
	cwd?: string;
	git_root?: string;
	repository?: string;
	branch?: string;
	client_name?: string;
	name?: string;
	summary?: string;
	created_at?: string;
	updated_at?: string;
}

export function readCopilotSessionInfo(session: CopilotSessionDir, fileState?: CopilotFileState): SessionInfo {
	let y: WorkspaceYaml = {};
	try {
		const parsed = parseYaml(fs.readFileSync(session.yamlPath, 'utf8'));
		if (parsed && typeof parsed === 'object') {
			y = parsed as WorkspaceYaml;
		}
	} catch {
		// Missing or malformed metadata is not fatal; prompts remain searchable.
	}
	const created = Date.parse(y.created_at ?? '');
	const updated = Date.parse(y.updated_at ?? '');
	return {
		key: copilotSessionKey(session.sessionId),
		source: 'copilot',
		sessionId: session.sessionId,
		title: str(y.name) ?? str(y.summary),
		cwd: str(y.cwd) ?? fileState?.cwd,
		repository: str(y.repository),
		branch: str(y.branch),
		client: str(y.client_name),
		createdAt: Number.isNaN(created) ? fileState?.startTime : created,
		updatedAt: Number.isNaN(updated) ? undefined : updated,
	};
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
