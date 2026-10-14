import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod/v4';
import type { PromptOrigin, PromptRecord, SessionInfo, SessionOpenTarget } from '../types.js';
import { safeReaddir } from '../util/fs.js';
import { findGitRoot, repoName } from '../util/git.js';
import { type PromptSourcePlugin, baseSourceOptions } from './base.js';
import { type SessionFileRead, firstLine, forEachJsonLine, leadingTag, readerError, syncSessionFiles, textContent, toEpochMs } from './sessionFiles.js';

export const claudeCodeSourceOptions = baseSourceOptions.extend({
	/** Claude Code configuration directory; default `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
	home: z.string().min(1).optional(),
});

export type ClaudeCodeSourceOptions = z.infer<typeof claudeCodeSourceOptions>;

/** Mirrors Claude Code: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeHome(): string {
	return process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

export interface ClaudeSessionFile {
	readonly sessionId: string;
	readonly path: string;
}

/** `<home>/projects/<encoded cwd>/<sessionId>.jsonl` (subagent transcripts live inside the same file as sidechains). */
export function listClaudeSessionFiles(home: string): ClaudeSessionFile[] {
	const root = path.join(home, 'projects');
	const out: ClaudeSessionFile[] = [];
	for (const project of safeReaddir(root)) {
		const dir = path.join(root, project);
		for (const name of safeReaddir(dir)) {
			if (name.endsWith('.jsonl')) {
				out.push({ sessionId: name.slice(0, -'.jsonl'.length), path: path.join(dir, name) });
			}
		}
	}
	return out;
}

export function claudeSessionKey(sessionId: string): string {
	return `claude-code:${sessionId}`;
}

/** Messages Claude Code injects as the user: slash commands, hook and IDE output, background-task notifications. */
/** The summary Claude Code inserts as a user message when a compacted session continues. */
const CONTINUATION = /^This session is being continued from a previous conversation/;

const INJECTED_TAG = /^(task-notification|system-reminder|local-command-.*|command-.*|bash-.*|ide|ide_.*|user-prompt-submit-hook.*)$/;

interface ClaudeUserLine {
	readonly uuid?: unknown;
	readonly timestamp?: unknown;
	readonly isSidechain?: unknown;
	readonly isMeta?: unknown;
	readonly promptSource?: unknown;
	readonly turnOrigin?: unknown;
	readonly message?: { readonly content?: unknown };
}

export function classifyClaudeOrigin(line: ClaudeUserLine, text: string): PromptOrigin {
	if (line.isMeta === true || line.turnOrigin === 'task_notification' || CONTINUATION.test(text)) {
		return 'system';
	}
	if (line.isSidechain === true || line.promptSource === 'sdk') {
		return 'agent';
	}
	const tag = leadingTag(text);
	return tag && INJECTED_TAG.test(tag) ? 'system' : 'human';
}

function clientFor(entrypoint: unknown): string {
	const e = typeof entrypoint === 'string' ? entrypoint : '';
	if (e.startsWith('sdk')) {
		return 'claude/sdk';
	}
	if (e.includes('vscode')) {
		return 'claude/vscode';
	}
	return 'claude/cli';
}

/** Projects one Claude Code session log to prompts and session metadata. */
export function readClaudeSession(file: ClaudeSessionFile, size: number): SessionFileRead & { readonly error?: string } {
	const key = claudeSessionKey(file.sessionId);
	const prompts: PromptRecord[] = [];
	let title: string | undefined;
	let summary: string | undefined;
	let cwd: string | undefined;
	let branch: string | undefined;
	let client: string | undefined;
	let model: string | undefined;
	let firstModel: string | undefined;
	let createdAt: number | undefined;
	let updatedAt: number | undefined;
	let index = 0;
	const { badLines, oversized } = forEachJsonLine(
		file.path,
		size,
		entry => {
			const ts = toEpochMs(entry['timestamp']);
			if (ts !== undefined) {
				createdAt = createdAt === undefined ? ts : Math.min(createdAt, ts);
				updatedAt = updatedAt === undefined ? ts : Math.max(updatedAt, ts);
			}
			switch (entry['type']) {
				case 'user': {
					index++;
					const line = entry as ClaudeUserLine;
					const text = textContent(line.message?.content, ['text']);
					cwd ??= typeof entry['cwd'] === 'string' ? entry['cwd'] : undefined;
					branch ??= typeof entry['gitBranch'] === 'string' ? entry['gitBranch'] : undefined;
					client ??= clientFor(entry['entrypoint']);
					if (!text.trim()) {
						return;
					}
					prompts.push({
						id: `${key}:${typeof line.uuid === 'string' ? line.uuid : `#${index}`}`,
						sessionKey: key,
						text,
						timestamp: ts ?? updatedAt ?? 0,
						origin: classifyClaudeOrigin(line, text),
						seq: prompts.length,
						model,
					});
					return;
				}
				case 'assistant': {
					const m = (entry['message'] as { model?: unknown } | undefined)?.model;
					if (typeof m === 'string') {
						model = m;
						firstModel ??= m;
					}
					return;
				}
				case 'ai-title':
					title = typeof entry['aiTitle'] === 'string' ? entry['aiTitle'] : title;
					return;
				case 'summary':
					summary = typeof entry['summary'] === 'string' ? entry['summary'] : summary;
					return;
				default:
			}
		},
		{
			// Lines whose type is visible early and not needed are skipped before parsing; unknown heads are parsed.
			wantLine: head => {
				const m = /"type":"([a-z-]+)"/.exec(head);
				return !m || m[1] === 'user' || m[1] === 'assistant' || m[1] === 'ai-title' || m[1] === 'summary';
			},
		},
	);
	// Prompts sent before the first reply get the model that answered them.
	const withModels = prompts.map(p => (p.model === undefined && firstModel ? { ...p, model: firstModel } : p));
	const firstHuman = withModels.find(p => p.origin === 'human');
	const gitRoot = cwd ? findGitRoot(cwd) : undefined;
	const session: SessionInfo = {
		key,
		source: 'claude-code',
		sessionId: file.sessionId,
		title: title?.trim() || summary?.trim() || (firstHuman ? firstLine(firstHuman.text, 80) : undefined),
		cwd,
		repository: gitRoot ? repoName(gitRoot) : undefined,
		branch,
		client: client ?? 'claude/cli',
		createdAt,
		updatedAt: updatedAt ?? fs.statSync(file.path).mtimeMs,
	};
	return { session, prompts: withModels, error: readerError(file.path, badLines, oversized) };
}

/** Claude Code sessions: `~/.claude/projects/<project>/<session>.jsonl`, re-read whole when a file changes. */
export const claudeCodeSource: PromptSourcePlugin<ClaudeCodeSourceOptions> = {
	id: 'claude-code',
	label: 'Claude Code',
	description: 'Claude Code sessions (~/.claude/projects), including the Agent SDK and the VS Code extension.',
	aliases: ['claude'],
	options: claudeCodeSourceOptions,
	clients: [
		{ id: 'claude/cli', label: 'Claude Code', icon: 'terminal', color: 'orange', aliases: ['claude-code', 'claude-cli'] },
		{ id: 'claude/sdk', label: 'Claude Agent SDK', icon: 'code', color: 'orange', aliases: ['claude-sdk'] },
		{ id: 'claude/vscode', label: 'Claude Code (VS Code)', icon: 'vscode', color: 'orange', aliases: ['claude-vscode'] },
	],

	sync(o, ctx) {
		const errors: string[] = [];
		return syncSessionFiles(ctx, {
			kind: 'claude-code',
			version: 1,
			files: listClaudeSessionFiles(o.home ?? claudeHome()),
			read: (file, st) => {
				const r = readClaudeSession(file, st.size);
				if (r.error) {
					errors.push(r.error);
				}
				return r.prompts.length ? r : undefined;
			},
		}).then(r => ({ ...r, errors: [...r.errors, ...errors] }));
	},

	openTargets(s: SessionInfo): SessionOpenTarget[] {
		return [{ kind: 'terminal-resume', label: 'Resume with Claude Code', command: `claude --resume ${s.sessionId}`, cwd: s.cwd }];
	},
};
