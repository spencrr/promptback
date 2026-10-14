import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod/v4';
import type { PromptOrigin, PromptRecord, SessionInfo, SessionOpenTarget } from '../types.js';
import { safeReaddir } from '../util/fs.js';
import { findGitRoot, parseRemote, repoName } from '../util/git.js';
import { baseSourceOptions, isShellSafeId, type PromptSourcePlugin } from './base.js';
import {
	firstLine,
	forEachJsonLine,
	leadingTag,
	readerError,
	type SessionFileRead,
	syncSessionFiles,
	textContent,
	toEpochMs,
} from './sessionFiles.js';

export const codexSourceOptions = baseSourceOptions.extend({
	/** Codex home; default `$CODEX_HOME`, else `~/.codex`. */
	home: z.string().min(1).optional(),
});

export type CodexSourceOptions = z.infer<typeof codexSourceOptions>;

/** Mirrors Codex CLI: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(): string {
	return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export interface CodexSessionFile {
	/** Thread id from the file name; `session_meta` inside the file is authoritative. */
	readonly sessionId: string;
	readonly path: string;
}

const ROLLOUT = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;

/** `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` and the same under `archived_sessions`. */
export function listCodexSessionFiles(home: string): CodexSessionFile[] {
	const out: CodexSessionFile[] = [];
	const walk = (dir: string, depth: number) => {
		for (const name of safeReaddir(dir)) {
			const p = path.join(dir, name);
			const m = ROLLOUT.exec(name);
			if (m) {
				out.push({ sessionId: m[1]!, path: p });
			} else if (depth < 4 && /^\d+$/.test(name)) {
				walk(p, depth + 1);
			}
		}
	};
	walk(path.join(home, 'sessions'), 0);
	walk(path.join(home, 'archived_sessions'), 0);
	return out;
}

export function codexSessionKey(sessionId: string): string {
	return `codex:${sessionId}`;
}

/** Context Codex injects as user messages: environment, instructions, sub-agent and abort notifications. */
const INJECTED_TAG =
	/^(environment_context|user_instructions|permissions.*|subagent_notification|turn_aborted|side-chat-context|AGENTS\.md.*)$/;

export function classifyCodexOrigin(text: string, subagentThread: boolean): PromptOrigin {
	if (subagentThread) {
		return 'agent';
	}
	const tag = leadingTag(text);
	return tag && INJECTED_TAG.test(tag) ? 'system' : 'human';
}

function clientFor(originator: unknown): string {
	const o = typeof originator === 'string' ? originator.toLowerCase() : '';
	if (o.includes('vscode') || o.includes('agent_host')) {
		return 'codex/vscode';
	}
	if (o.includes('exec')) {
		return 'codex/exec';
	}
	return 'codex/cli';
}

// biome-ignore-start lint/style/useNamingConvention: field names mirror Codex's session_meta payload.
interface SessionMeta {
	readonly id?: unknown;
	readonly timestamp?: unknown;
	readonly cwd?: unknown;
	readonly originator?: unknown;
	readonly source?: unknown;
	readonly model?: unknown;
	readonly git?: { readonly branch?: unknown; readonly repository_url?: unknown };
}
// biome-ignore-end lint/style/useNamingConvention: field names mirror Codex's session_meta payload.

/** Projects one Codex rollout to prompts and session metadata. */
export function readCodexSession(file: CodexSessionFile, size: number): SessionFileRead & { readonly error?: string } {
	let meta: SessionMeta = {};
	let model: string | undefined;
	let createdAt: number | undefined;
	let updatedAt: number | undefined;
	// The session key is known only once `session_meta` has been read, so prompts are assembled afterwards.
	const pending: {
		text: string;
		ts: number | undefined;
		id: string | undefined;
		fromEvent: boolean;
		model: string | undefined;
	}[] = [];
	const { badLines, oversized } = forEachJsonLine(
		file.path,
		size,
		entry => {
			const ts = toEpochMs(entry.timestamp);
			if (ts !== undefined) {
				createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
				updatedAt = updatedAt === undefined ? ts : Math.max(updatedAt, ts);
			}
			const payload = entry.payload;
			if (!payload || typeof payload !== 'object') {
				return;
			}
			const p = payload as Record<string, unknown>;
			switch (entry.type) {
				case 'session_meta':
					meta = p as SessionMeta;
					if (typeof p.model === 'string') {
						model ??= p.model;
					}
					return;
				case 'turn_context':
					if (typeof p.model === 'string') {
						model = p.model;
					}
					return;
				case 'response_item':
					if (p.type === 'message' && p.role === 'user') {
						const text = textContent(p.content, ['input_text']);
						if (text.trim()) {
							pending.push({
								text,
								ts,
								id: typeof p.id === 'string' && p.id ? p.id : undefined,
								fromEvent: false,
								model,
							});
						}
					}
					return;
				case 'event_msg':
					if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
						pending.push({ text: p.message, ts, id: undefined, fromEvent: true, model });
					}
					return;
				default:
			}
		},
		{
			wantLine: head => {
				const m = /"type":"([a-z_]+)"/.exec(head);
				return (
					!m ||
					m[1] === 'session_meta' ||
					m[1] === 'turn_context' ||
					m[1] === 'response_item' ||
					m[1] === 'event_msg'
				);
			},
		},
	);
	const sessionId = typeof meta.id === 'string' && meta.id ? meta.id : file.sessionId;
	const key = codexSessionKey(sessionId);
	const subagent = typeof meta.source === 'object' && meta.source !== null;
	// Older rollouts carry prompts only as events; newer ones as response items (their events would be duplicates).
	const useEvents = pending.every(p => p.fromEvent);
	const prompts: PromptRecord[] = pending
		.map((p, i) => ({ ...p, index: i + 1 }))
		.filter(p => p.fromEvent === useEvents)
		.map((p, seq) => ({
			id: `${key}:${p.id ?? `#${p.index}`}`,
			sessionKey: key,
			text: p.text,
			timestamp: p.ts ?? updatedAt ?? 0,
			origin: classifyCodexOrigin(p.text, subagent),
			seq,
			model: p.model,
		}));
	const cwd = typeof meta.cwd === 'string' ? meta.cwd : undefined;
	const gitRoot = cwd ? findGitRoot(cwd) : undefined;
	const firstHuman = prompts.find(p => p.origin === 'human');
	const session: SessionInfo = {
		key,
		source: 'codex',
		sessionId,
		title: firstHuman ? firstLine(firstHuman.text, 80) : undefined,
		cwd,
		repository:
			parseRemote(typeof meta.git?.repository_url === 'string' ? meta.git.repository_url : undefined) ??
			(gitRoot ? repoName(gitRoot) : undefined),
		branch: typeof meta.git?.branch === 'string' ? meta.git.branch : undefined,
		client: clientFor(meta.originator),
		createdAt: toEpochMs(meta.timestamp) ?? createdAt,
		updatedAt: updatedAt ?? fs.statSync(file.path).mtimeMs,
	};
	return { session, prompts, error: readerError(file.path, badLines, oversized) };
}

/** Codex CLI threads: `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`, re-read whole when a file changes. */
export const codexSource: PromptSourcePlugin<CodexSourceOptions> = {
	id: 'codex',
	label: 'Codex',
	description: 'OpenAI Codex threads (~/.codex/sessions), from the CLI, exec and the VS Code integrations.',
	aliases: ['openai-codex'],
	options: codexSourceOptions,
	clients: [
		{ id: 'codex/cli', label: 'Codex CLI', icon: 'terminal', color: 'yellow', aliases: ['codex-cli'] },
		{ id: 'codex/exec', label: 'Codex exec', icon: 'play', color: 'yellow', aliases: ['codex-exec'] },
		{ id: 'codex/vscode', label: 'Codex (VS Code)', icon: 'vscode', color: 'yellow', aliases: ['codex-vscode'] },
	],

	sync(o, ctx) {
		const errors: string[] = [];
		return syncSessionFiles(ctx, {
			kind: 'codex',
			version: 1,
			files: listCodexSessionFiles(o.home ?? codexHome()),
			read: (file, st) => {
				const r = readCodexSession(file, st.size);
				if (r.error) {
					errors.push(r.error);
				}
				return r.prompts.length > 0 ? r : undefined;
			},
		}).then(r => ({ ...r, errors: [...r.errors, ...errors] }));
	},

	openTargets(s: SessionInfo): SessionOpenTarget[] {
		if (!isShellSafeId(s.sessionId)) {
			return [];
		}
		return [
			{ kind: 'terminal-resume', label: 'Resume with Codex', command: `codex resume ${s.sessionId}`, cwd: s.cwd },
		];
	},
};
