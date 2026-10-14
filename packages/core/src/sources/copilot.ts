import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PromptOrigin, PromptRecord, SessionInfo } from '../types.js';
import { findGitRoot, gitRootsInText, repoName } from '../util/git.js';
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
	/** Workspaceless sessions only: how often each git root appeared in tool-call paths (for repo inference). */
	readonly repoHits?: Readonly<Record<string, number>>;
	/** Set once tool calls up to `cursor` have been scanned for repo inference (backfills older indexes). */
	readonly repoScanned?: boolean;
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
		out.push({
			sessionId: e.name,
			dir,
			eventsPath: path.join(dir, 'events.jsonl'),
			yamlPath: path.join(dir, 'workspace.yaml'),
		});
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
 * For workspaceless sessions (cwd under `<copilotHome>/chats`), tool-call paths are also tallied by git root so the
 * session's repository can be inferred.
 */
export function readCopilotEvents(
	session: CopilotSessionDir,
	prev: CopilotFileState | undefined,
	copilotHome?: string,
): CopilotReadResult | undefined {
	let st: fs.Stats | undefined;
	try {
		st = fs.statSync(session.eventsPath, { throwIfNoEntry: false });
	} catch {
		return undefined;
	}
	if (!st) {
		return undefined;
	}
	const needsRepoBackfill =
		prev !== undefined &&
		!prev.repoScanned &&
		copilotHome !== undefined &&
		needsRepoInference(prev.cwd, copilotHome);
	if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && !needsRepoBackfill) {
		return undefined;
	}
	const prevHeadLen = prev?.headLen ?? 0;
	const reset =
		!prev ||
		st.size < prev.cursor ||
		st.size < prevHeadLen ||
		(prevHeadLen > 0 && headHash(session.eventsPath, prevHeadLen) !== prev.headHash);
	const base: CopilotFileState = reset ? { size: 0, mtimeMs: 0, cursor: 0, headHash: '', headLen: 0, seq: 0 } : prev!;

	let seq = base.seq;
	let model = base.model;
	let startTime = base.startTime;
	let cwd = base.cwd;
	let badLines = 0;
	const prompts: PromptRecord[] = [];
	const sessionKey = copilotSessionKey(session.sessionId);
	const repoHits: Record<string, number> = { ...base.repoHits };
	const tallyTools = () => copilotHome !== undefined && needsRepoInference(cwd, copilotHome);
	const tally = (data: Record<string, unknown>) => tallyToolCall(data, repoHits, copilotHome!);

	if (needsRepoBackfill && !reset) {
		scanLines(session.eventsPath, {
			start: 0,
			end: base.cursor,
			wantLine: head => head.includes(TOOL_START),
			onLine: line => {
				try {
					tally((JSON.parse(line.toString('utf8')) as { data?: Record<string, unknown> }).data ?? {});
				} catch {
					// ignore
				}
			},
		});
	}

	const { endOffset, oversized } = scanLines(session.eventsPath, {
		start: base.cursor,
		end: st.size,
		wantLine: head => WANTED.some(w => head.includes(w)) || (head.includes(TOOL_START) && tallyTools()),
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
				case 'tool.execution_start':
					tally(data);
					break;
				case 'session.start': {
					if (typeof data.selectedModel === 'string') {
						model = data.selectedModel;
					}
					const t = Date.parse(String(data.startTime ?? e.timestamp ?? ''));
					if (!Number.isNaN(t)) {
						startTime = t;
					}
					const ctx = data.context as { cwd?: unknown } | undefined;
					if (typeof ctx?.cwd === 'string') {
						cwd = ctx.cwd;
					}
					break;
				}
				case 'session.model_change':
					if (typeof data.newModel === 'string') {
						model = data.newModel;
					}
					break;
				case 'user.message': {
					const content = data.content;
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
		state: {
			size: st.size,
			mtimeMs: st.mtimeMs,
			cursor: endOffset,
			headHash: hh,
			headLen,
			seq,
			model,
			startTime,
			cwd,
			repoHits: Object.keys(repoHits).length > 0 ? repoHits : undefined,
			repoScanned: true,
		},
		reset,
		prompts,
		oversized,
		badLines,
	};
}

const TOOL_START = '"type":"tool.execution_start"';
const PATH_ARGS = ['path', 'paths', 'command', 'cwd', 'file', 'filePath', 'directory'];

function tallyToolCall(data: Record<string, unknown>, hits: Record<string, number>, copilotHome: string): void {
	const args = data.arguments;
	if (!args || typeof args !== 'object') {
		return;
	}
	const home = os.homedir();
	const ignore = (p: string) => p.toLowerCase().startsWith(copilotHome.toLowerCase());
	for (const key of PATH_ARGS) {
		const v = (args as Record<string, unknown>)[key];
		for (const s of Array.isArray(v) ? v : [v]) {
			if (typeof s === 'string' && s.length < 20_000) {
				for (const root of gitRootsInText(s, home, ignore)) {
					hits[root] = (hits[root] ?? 0) + 1;
				}
			}
		}
	}
}

/** Repo inference applies when the session folder isn't inside a git repository (workspaceless chats, `~/src`, ...). */
function needsRepoInference(cwd: string | undefined, copilotHome: string): boolean {
	if (!cwd) {
		return false;
	}
	return isWorkspaceless(cwd, copilotHome) || !findGitRoot(cwd);
}

/** Sessions started without a folder live in `<copilotHome>/chats/<id>` (e.g. Agents-window chats). */
export function isWorkspaceless(cwd: string | undefined, copilotHome: string): boolean {
	if (!cwd) {
		return false;
	}
	const rel = path.relative(path.join(copilotHome, 'chats'), cwd);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The git root referenced by most tool calls, if it clearly dominates (≥ 3 hits and ≥ 50% of all hits). */
export function dominantRoot(hits: Readonly<Record<string, number>> | undefined): string | undefined {
	if (!hits) {
		return undefined;
	}
	const entries = Object.entries(hits).sort((a, b) => b[1] - a[1]);
	const total = entries.reduce((n, [, c]) => n + c, 0);
	const [root, count] = entries[0] ?? [];
	return root && count! >= 3 && count! / total >= 0.5 ? root : undefined;
}

// biome-ignore-start lint/style/useNamingConvention: field names mirror Copilot's workspace.yaml.
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
// biome-ignore-end lint/style/useNamingConvention: field names mirror Copilot's workspace.yaml.

/**
 * Session metadata from `workspace.yaml`. Repository: the recorded one, else the git `origin` of the session folder,
 * else (workspaceless chats) the git root that dominates the session's tool calls, flagged as inferred.
 */
export function readCopilotSessionInfo(
	session: CopilotSessionDir,
	fileState?: CopilotFileState,
	copilotHome?: string,
): SessionInfo {
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
	const cwd = str(y.cwd) ?? fileState?.cwd;
	const workspaceless = copilotHome !== undefined && isWorkspaceless(cwd, copilotHome);
	let repository = str(y.repository);
	let repositoryInferred = false;
	if (!repository) {
		const dir = str(y.git_root) ?? cwd;
		const root = workspaceless || !dir ? undefined : findGitRoot(dir);
		if (root) {
			repository = repoName(root);
		} else {
			const inferred = dominantRoot(fileState?.repoHits);
			repository = inferred ? repoName(inferred) : undefined;
			repositoryInferred = Boolean(inferred);
		}
	}
	return {
		key: copilotSessionKey(session.sessionId),
		source: 'copilot',
		sessionId: session.sessionId,
		title: str(y.name) ?? str(y.summary),
		cwd,
		repository,
		repositoryInferred: repositoryInferred || undefined,
		workspaceless: workspaceless || undefined,
		branch: str(y.branch),
		client: str(y.client_name),
		createdAt: Number.isNaN(created) ? fileState?.startTime : created,
		updatedAt: Number.isNaN(updated) ? undefined : updated,
	};
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
