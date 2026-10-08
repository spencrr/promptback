import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PromptRecord, SessionInfo } from '../types.js';
import { scanLines } from '../util/lines.js';

export interface ChatSessionFile {
	readonly product: string;
	readonly sessionId: string;
	readonly path: string;
	readonly format: 'jsonl' | 'json';
	/** Folder/workspace URI from `workspaceStorage/<hash>/workspace.json`; undefined for empty-window sessions. */
	readonly workspaceUri?: string;
}

/**
 * Enumerates VS Code chat-panel session files for one product root:
 * - `User/workspaceStorage/<hash>/chatSessions/<id>.jsonl|.json`
 * - `User/globalStorage/emptyWindowChatSessions/<id>.jsonl|.json`
 * A `.jsonl` mutation log takes precedence over a legacy `.json` snapshot with the same id
 * (mirrors `ChatSessionStore.readSessionFromLocation`).
 */
export function listChatSessionFiles(product: string, productRoot: string): ChatSessionFile[] {
	const out: ChatSessionFile[] = [];
	const wsRoot = path.join(productRoot, 'User', 'workspaceStorage');
	for (const hash of safeReaddir(wsRoot)) {
		const dir = path.join(wsRoot, hash, 'chatSessions');
		const files = safeReaddir(dir);
		if (files.length === 0) {
			continue;
		}
		collect(out, product, dir, files, readWorkspaceUri(path.join(wsRoot, hash, 'workspace.json')));
	}
	const emptyDir = path.join(productRoot, 'User', 'globalStorage', 'emptyWindowChatSessions');
	collect(out, product, emptyDir, safeReaddir(emptyDir), undefined);
	return out;
}

function collect(out: ChatSessionFile[], product: string, dir: string, files: string[], workspaceUri: string | undefined): void {
	const jsonl = new Set(files.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length)));
	for (const f of files) {
		if (f.endsWith('.jsonl')) {
			out.push({ product, sessionId: f.slice(0, -6), path: path.join(dir, f), format: 'jsonl', workspaceUri });
		} else if (f.endsWith('.json') && !jsonl.has(f.slice(0, -5))) {
			out.push({ product, sessionId: f.slice(0, -5), path: path.join(dir, f), format: 'json', workspaceUri });
		}
	}
}

function readWorkspaceUri(file: string): string | undefined {
	try {
		const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { folder?: string; workspace?: string };
		return j.folder ?? j.workspace;
	} catch {
		return undefined;
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

export function chatSessionKey(product: string, sessionId: string): string {
	return `vscode-chat:${product}:${sessionId}`;
}

type ObjectPath = (string | number)[];
type Entry =
	| { kind: 0; v: unknown }
	| { kind: 1; k: ObjectPath; v: unknown }
	| { kind: 2; k: ObjectPath; v?: unknown[]; i?: number }
	| { kind: 3; k: ObjectPath };

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Replays an `ObjectMutationLog` (vscode/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts, `read`,
 * `_applySet`, `_applyPush`). Kind 0 replaces state, 1 sets at path, 2 truncates to `i` then appends, 3 sets undefined.
 */
export function replayMutationLog(lines: Iterable<string>): unknown {
	let state: unknown;
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		const entry = JSON.parse(line) as Entry;
		if (entry.kind === 0) {
			state = entry.v;
			continue;
		}
		if (state === undefined) {
			throw new Error('Log file is missing an initial entry');
		}
		switch (entry.kind) {
			case 1:
				applySet(state, entry.k, entry.v);
				break;
			case 2:
				applyPush(state, entry.k, entry.v, entry.i);
				break;
			case 3:
				applySet(state, entry.k, undefined);
				break;
			default:
				throw new Error(`Unknown mutation kind ${(entry as { kind: unknown }).kind}`);
		}
	}
	if (state === undefined) {
		throw new Error('Empty log file');
	}
	return state;
}

function walk(state: unknown, p: ObjectPath): Record<string | number, unknown> {
	let current = state as Record<string | number, unknown>;
	for (let i = 0; i < p.length - 1; i++) {
		const key = p[i]!;
		if (typeof key === 'string' && UNSAFE_KEYS.has(key)) {
			throw new Error('Unsafe path');
		}
		current = current[key] as Record<string | number, unknown>;
		if (current === null || typeof current !== 'object') {
			throw new Error(`Invalid mutation path ${JSON.stringify(p)}`);
		}
	}
	return current;
}

function applySet(state: unknown, p: ObjectPath, value: unknown): void {
	if (p.length === 0) {
		return;
	}
	const last = p[p.length - 1]!;
	if (typeof last === 'string' && UNSAFE_KEYS.has(last)) {
		throw new Error('Unsafe path');
	}
	walk(state, p)[last] = value;
}

function applyPush(state: unknown, p: ObjectPath, values: unknown[] | undefined, startIndex: number | undefined): void {
	const parent = walk(state, p);
	const key = p[p.length - 1]!;
	if (typeof key === 'string' && UNSAFE_KEYS.has(key)) {
		throw new Error('Unsafe path');
	}
	const arr = (parent[key] as unknown[]) || [];
	if (startIndex !== undefined) {
		arr.length = startIndex;
	}
	if (values && values.length > 0) {
		arr.push(...values);
	}
	parent[key] = arr;
}

interface SerializedRequest {
	requestId?: string;
	timestamp?: number;
	message?: string | { text?: string };
	modelId?: string;
	isSystemInitiated?: boolean;
	isHidden?: boolean;
}

interface SerializedSession {
	sessionId?: string;
	creationDate?: number;
	lastMessageDate?: number;
	customTitle?: string;
	requests?: (SerializedRequest | undefined | null)[];
}

export interface ChatReadResult {
	readonly session: SessionInfo;
	readonly prompts: PromptRecord[];
}

/** Reads a whole chat session file (full replay) and projects it to prompts + session metadata. */
export function readChatSession(file: ChatSessionFile, maxBytes = 512 * 1024 * 1024): ChatReadResult {
	const st = fs.statSync(file.path);
	if (st.size > maxBytes) {
		throw new Error(`Chat session file too large (${st.size} bytes): ${file.path}`);
	}
	let raw: SerializedSession;
	if (file.format === 'json') {
		raw = JSON.parse(fs.readFileSync(file.path, 'utf8')) as SerializedSession;
	} else {
		const lines: string[] = [];
		scanLines(file.path, { start: 0, end: st.size, wantLine: () => true, onLine: l => lines.push(l.toString('utf8')) });
		raw = replayMutationLog(lines) as SerializedSession;
	}
	return projectChatSession(file, raw, st.mtimeMs);
}

export function projectChatSession(file: ChatSessionFile, raw: SerializedSession, mtimeMs: number): ChatReadResult {
	const sessionId = raw.sessionId ?? file.sessionId;
	const key = chatSessionKey(file.product, sessionId);
	const prompts: PromptRecord[] = [];
	let seq = 0;
	let firstText: string | undefined;
	for (const [i, req] of (raw.requests ?? []).entries()) {
		if (!req || typeof req !== 'object') {
			continue;
		}
		const text = typeof req.message === 'string' ? req.message : req.message?.text;
		if (typeof text !== 'string' || !text.trim()) {
			continue;
		}
		firstText ??= text;
		prompts.push({
			id: `${key}:${req.requestId ?? `#${i}`}`,
			sessionKey: key,
			text,
			timestamp: typeof req.timestamp === 'number' ? req.timestamp : (raw.creationDate ?? mtimeMs),
			origin: req.isSystemInitiated ? 'system' : 'human',
			seq: seq++,
			model: req.modelId,
		});
	}
	const session: SessionInfo = {
		key,
		source: 'vscode-chat',
		sessionId,
		title: raw.customTitle?.trim() || (firstText ? firstLine(firstText, 80) : undefined),
		client: 'vscode-chat',
		product: file.product,
		workspaceUri: file.workspaceUri,
		cwd: file.workspaceUri ? uriToPath(file.workspaceUri) : undefined,
		createdAt: raw.creationDate,
		updatedAt: raw.lastMessageDate ?? mtimeMs,
	};
	return { session, prompts };
}

function firstLine(text: string, max: number): string {
	const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
	return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function uriToPath(uri: string): string {
	if (!uri.startsWith('file://')) {
		return uri;
	}
	try {
		let p = decodeURIComponent(new URL(uri).pathname);
		if (/^\/[a-zA-Z]:/.test(p)) {
			p = p.slice(1).replace(/\//g, '\\');
		}
		return p;
	} catch {
		return uri;
	}
}
