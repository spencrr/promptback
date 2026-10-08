import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { PromptOrigin, PromptRecord, SessionInfo, SourceKind } from './types.js';
import type { Chunk } from './search/chunk.js';
import { isAckText } from './search/query.js';

const SCHEMA_VERSION = 1;

export interface StoredPrompt extends PromptRecord {
	readonly rowid: number;
	readonly hash: string;
}

export interface PendingChunk {
	readonly hash: string;
	readonly text: string;
}

export interface PromptMeta {
	readonly rowid: number;
	readonly id: string;
	readonly hash: string;
	readonly ts: number;
	readonly origin: PromptOrigin;
	readonly sessionKey: string;
	readonly isAck: boolean;
	readonly model?: string;
	readonly seq: number;
	/** Characters. */
	readonly length: number;
}

export interface VectorMatrix {
	readonly dims: number;
	readonly count: number;
	readonly vectors: Float32Array;
	readonly promptRowids: Int32Array;
	readonly ords: Int32Array;
	readonly starts: Int32Array;
	readonly ends: Int32Array;
}

export function hashText(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Sessions joined with their Agents-window mapping (Copilot sessions only). */
const SESSION_SELECT = `SELECT s.*, l.agent_host_session_id, l.chat_id AS agent_host_chat_id, l.product AS agent_host_product
	FROM sessions s LEFT JOIN agent_host_links l ON s.source = 'copilot' AND l.sdk_session_id = s.session_id`;

type Row = Record<string, unknown>;

/** The index database. Owned by this tool; source stores are only ever read. */
export class Store {
	readonly db: DatabaseSync;
	private readonly stmts = new Map<string, StatementSync>();

	constructor(readonly file: string) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.db = new DatabaseSync(file);
		this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
			CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS sessions (
				key TEXT PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT, cwd TEXT, repository TEXT,
				branch TEXT, client TEXT, product TEXT, workspace_uri TEXT, created_at INTEGER, updated_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS agent_host_links (
				sdk_session_id TEXT PRIMARY KEY, agent_host_session_id TEXT NOT NULL, product TEXT NOT NULL, chat_id TEXT, title TEXT
			);
			CREATE TABLE IF NOT EXISTS prompts (
				rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_key TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
				ts INTEGER NOT NULL, origin TEXT NOT NULL, seq INTEGER NOT NULL, model TEXT, is_ack INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS prompts_session ON prompts(session_key);
			CREATE INDEX IF NOT EXISTS prompts_hash ON prompts(hash);
			CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(text, content='prompts', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
			CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON prompts BEGIN
				INSERT INTO prompts_fts(rowid, text) VALUES (new.rowid, new.text);
			END;
			CREATE TRIGGER IF NOT EXISTS prompts_ad AFTER DELETE ON prompts BEGIN
				INSERT INTO prompts_fts(prompts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
				DELETE FROM chunks WHERE prompt_rowid = old.rowid;
			END;
			CREATE TABLE IF NOT EXISTS chunks (
				rowid INTEGER PRIMARY KEY, prompt_rowid INTEGER NOT NULL, ord INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS chunks_prompt ON chunks(prompt_rowid);
			CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);
			CREATE TABLE IF NOT EXISTS embeddings (model TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (model, hash)) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
		`);
		const v = this.getMeta('schemaVersion');
		if (!v) {
			this.setMeta('schemaVersion', String(SCHEMA_VERSION));
		}
		// Additive column migrations only: the index file is shared by every VS Code build, the CLI and the MCP server.
		// Under the write lock so two processes upgrading at once don't both try to add a column.
		this.transaction(() => {
			this.addColumn('sessions', 'repo_inferred', 'INTEGER');
			this.addColumn('sessions', 'workspaceless', 'INTEGER');
		});
	}

	private addColumn(table: string, column: string, type: string): void {
		const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(r => String(r['name']));
		if (!cols.includes(column)) {
			this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
		}
	}

	private stmt(sql: string): StatementSync {
		let s = this.stmts.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.stmts.set(sql, s);
		}
		return s;
	}

	transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const r = fn();
			this.db.exec('COMMIT');
			return r;
		} catch (e) {
			this.db.exec('ROLLBACK');
			throw e;
		}
	}

	close(): void {
		this.stmts.clear();
		this.db.close();
	}

	// ---- meta / lease ---------------------------------------------------------------------------

	getMeta(key: string): string | undefined {
		const r = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
		return r ? String(r['value']) : undefined;
	}

	setMeta(key: string, value: string): void {
		this.stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
	}

	/** Single-writer lease shared by every window/process using this index. Owner format: `<host>:<pid>:<nonce>`. */
	tryAcquireLease(owner: string, ttlMs: number): boolean {
		return this.transaction(() => {
			const now = Date.now();
			const r = this.stmt('SELECT owner, expires FROM lease WHERE id = 1').get() as Row | undefined;
			if (r && r['owner'] !== owner && Number(r['expires']) > now && isOwnerAlive(String(r['owner']))) {
				return false;
			}
			this.stmt('INSERT INTO lease(id, owner, expires) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires')
				.run(owner, now + ttlMs);
			return true;
		});
	}

	releaseLease(owner: string): void {
		this.stmt('DELETE FROM lease WHERE id = 1 AND owner = ?').run(owner);
	}

	// ---- files (per-source read cursors) --------------------------------------------------------

	setFileState(file: string, kind: string, state: unknown): void {
		this.stmt('INSERT INTO files(path, kind, state) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET state = excluded.state')
			.run(file, kind, JSON.stringify(state));
	}

	/** Loads every cursor of one kind in a single query (avoids thousands of point lookups per sync). */
	loadFileStates<T>(kind: string): Map<string, T> {
		return new Map((this.stmt('SELECT path, state FROM files WHERE kind = ?').all(kind) as Row[])
			.map(r => [String(r['path']), JSON.parse(String(r['state'])) as T]));
	}

	deleteFile(file: string): void {
		this.stmt('DELETE FROM files WHERE path = ?').run(file);
	}

	// ---- sessions -------------------------------------------------------------------------------

	upsertSession(s: SessionInfo): void {
		this.stmt(`INSERT INTO sessions(key, source, session_id, title, cwd, repository, branch, client, product, workspace_uri, created_at, updated_at, repo_inferred, workspaceless)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET title = excluded.title, cwd = excluded.cwd, repository = excluded.repository, branch = excluded.branch,
				client = excluded.client, product = excluded.product, workspace_uri = excluded.workspace_uri,
				created_at = excluded.created_at, updated_at = excluded.updated_at,
				repo_inferred = excluded.repo_inferred, workspaceless = excluded.workspaceless`)
			.run(s.key, s.source, s.sessionId, n(s.title), n(s.cwd), n(s.repository), n(s.branch), n(s.client), n(s.product), n(s.workspaceUri),
				n(s.createdAt), n(s.updatedAt), s.repositoryInferred ? 1 : 0, s.workspaceless ? 1 : 0);
	}

	deleteSession(key: string): number {
		const removed = this.stmt('DELETE FROM prompts WHERE session_key = ?').run(key).changes;
		this.stmt('DELETE FROM sessions WHERE key = ?').run(key);
		return Number(removed);
	}

	replaceAgentHostLinks(links: { sdkSessionId: string; agentHostSessionId: string; product: string; chatId?: string; title?: string }[]): void {
		this.stmt('DELETE FROM agent_host_links').run();
		const ins = this.stmt('INSERT OR REPLACE INTO agent_host_links(sdk_session_id, agent_host_session_id, product, chat_id, title) VALUES (?, ?, ?, ?, ?)');
		for (const l of links) {
			ins.run(l.sdkSessionId, l.agentHostSessionId, l.product, n(l.chatId), n(l.title));
		}
	}

	// ---- prompts --------------------------------------------------------------------------------

	/** Inserts prompts (ignoring already-known ids) and their chunks. Returns the number inserted. */
	insertPrompts(prompts: readonly PromptRecord[], chunker: (text: string) => Chunk[]): number {
		const ins = this.stmt(`INSERT INTO prompts(id, session_key, text, hash, ts, origin, seq, model, is_ack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO NOTHING`);
		const insChunk = this.stmt('INSERT INTO chunks(prompt_rowid, ord, start, "end", hash) VALUES (?, ?, ?, ?, ?)');
		let count = 0;
		for (const p of prompts) {
			const r = ins.run(p.id, p.sessionKey, p.text, hashText(p.text), p.timestamp, p.origin, p.seq, n(p.model), isAckText(p.text) ? 1 : 0);
			if (r.changes === 0) {
				continue;
			}
			count++;
			const rowid = Number(r.lastInsertRowid);
			for (const [ord, c] of chunker(p.text).entries()) {
				insChunk.run(rowid, ord, c.start, c.end, hashText(c.text));
			}
		}
		return count;
	}

	/** Replaces all prompts of a session (used for full re-reads). Returns [added, removed]. */
	replaceSessionPrompts(sessionKey: string, prompts: readonly PromptRecord[], chunker: (text: string) => Chunk[]): [number, number] {
		const existing = new Map((this.stmt('SELECT id, hash, ts, seq, origin FROM prompts WHERE session_key = ?').all(sessionKey) as Row[])
			.map(r => [String(r['id']), r]));
		const keep = new Set<string>();
		const changed: PromptRecord[] = [];
		for (const p of prompts) {
			const e = existing.get(p.id);
			if (e && e['hash'] === hashText(p.text) && Number(e['ts']) === p.timestamp && Number(e['seq']) === p.seq && e['origin'] === p.origin) {
				keep.add(p.id);
			} else {
				changed.push(p);
			}
		}
		let removed = 0;
		const del = this.stmt('DELETE FROM prompts WHERE id = ?');
		for (const id of existing.keys()) {
			if (!keep.has(id)) {
				removed += Number(del.run(id).changes);
			}
		}
		const added = this.insertPrompts(changed, chunker);
		return [added, removed];
	}

	getPromptsByRowid(rowids: Iterable<number>): Map<number, StoredPrompt> {
		const out = new Map<number, StoredPrompt>();
		const s = this.stmt('SELECT * FROM prompts WHERE rowid = ?');
		for (const id of new Set(rowids)) {
			const r = s.get(id) as Row | undefined;
			if (r) {
				out.set(id, rowToPrompt(r));
			}
		}
		return out;
	}

	getPrompt(id: string): StoredPrompt | undefined {
		const r = this.stmt('SELECT * FROM prompts WHERE id = ?').get(id) as Row | undefined;
		return r ? rowToPrompt(r) : undefined;
	}

	getSessionPrompts(sessionKey: string): StoredPrompt[] {
		return (this.stmt('SELECT * FROM prompts WHERE session_key = ? ORDER BY seq').all(sessionKey) as Row[]).map(rowToPrompt);
	}

	/** All prompt rows with filterable metadata, for in-memory filtering/ranking. */
	listPromptMeta(): PromptMeta[] {
		return (this.stmt('SELECT rowid, id, hash, ts, origin, session_key, is_ack, model, seq, length(text) AS len FROM prompts').all() as Row[]).map(r => ({
			rowid: Number(r['rowid']), id: String(r['id']), hash: String(r['hash']), ts: Number(r['ts']), origin: r['origin'] as PromptOrigin,
			sessionKey: String(r['session_key']), isAck: Number(r['is_ack']) === 1, model: opt<string>(r['model']),
			seq: Number(r['seq']), length: Number(r['len']),
		}));
	}

	/** First `chars` characters of every prompt, streamed. */
	*iterateTexts(chars: number): Generator<string> {
		for (const r of this.db.prepare('SELECT substr(text, 1, ?) AS t FROM prompts').iterate(chars) as Iterable<Row>) {
			yield String(r['t']);
		}
	}

	/** First `chars` characters of each prompt (avoids loading 40k-char prompts just to list them). */
	getPreviews(rowids: Iterable<number>, chars: number): Map<number, string> {
		const s = this.stmt('SELECT substr(text, 1, ?) AS p FROM prompts WHERE rowid = ?');
		const out = new Map<number, string>();
		for (const id of rowids) {
			const r = s.get(chars, id) as Row | undefined;
			if (r) {
				out.set(id, String(r['p']));
			}
		}
		return out;
	}

	listAllSessions(): SessionInfo[] {
		return (this.stmt(`${SESSION_SELECT}`).all() as Row[]).map(rowToSession);
	}

	/** BM25 full-text search over all prompts. Returns rowids best-first. Malformed expressions yield no hits. */
	searchFts(match: string): { rowid: number; score: number }[] {
		try {
			return (this.stmt('SELECT rowid, -bm25(prompts_fts) AS score FROM prompts_fts WHERE prompts_fts MATCH ? ORDER BY bm25(prompts_fts)')
				.all(match) as Row[]).map(r => ({ rowid: Number(r['rowid']), score: Number(r['score']) }));
		} catch {
			return [];
		}
	}

	// ---- embeddings -----------------------------------------------------------------------------

	/** Distinct chunk texts with no embedding for `model`, restricted to prompts of the given origins, newest first. */
	pendingChunks(model: string, origins: readonly PromptOrigin[], limit: number): PendingChunk[] {
		const placeholders = origins.map(() => '?').join(',');
		// Slice in JS: offsets are UTF-16 code units, while SQLite substr() counts code points.
		const rows = this.db.prepare(`SELECT c.hash AS hash, p.text AS text, c.start AS s, c."end" AS e
			FROM chunks c JOIN prompts p ON p.rowid = c.prompt_rowid
			LEFT JOIN embeddings e ON e.model = ? AND e.hash = c.hash
			WHERE e.hash IS NULL AND p.origin IN (${placeholders})
			GROUP BY c.hash ORDER BY MAX(p.ts) DESC LIMIT ?`).all(model, ...origins, limit) as Row[];
		return rows.map(r => ({ hash: String(r['hash']), text: String(r['text']).slice(Number(r['s']), Number(r['e'])) }));
	}

	countPendingChunks(model: string, origins: readonly PromptOrigin[]): number {
		const placeholders = origins.map(() => '?').join(',');
		const r = this.db.prepare(`SELECT COUNT(DISTINCT c.hash) AS n FROM chunks c JOIN prompts p ON p.rowid = c.prompt_rowid
			LEFT JOIN embeddings e ON e.model = ? AND e.hash = c.hash WHERE e.hash IS NULL AND p.origin IN (${placeholders})`).get(model, ...origins) as Row;
		return Number(r['n']);
	}

	saveEmbeddings(model: string, items: readonly { hash: string; vector: Float32Array }[]): void {
		const s = this.stmt('INSERT OR REPLACE INTO embeddings(model, hash, vec) VALUES (?, ?, ?)');
		for (const it of items) {
			s.run(model, it.hash, new Uint8Array(it.vector.buffer, it.vector.byteOffset, it.vector.byteLength));
		}
	}

	loadVectorMatrix(model: string, dims: number): VectorMatrix {
		const rows = this.stmt(`SELECT c.prompt_rowid AS pr, c.ord AS o, c.start AS s, c."end" AS e, em.vec AS vec FROM chunks c
			JOIN embeddings em ON em.model = ? AND em.hash = c.hash`).all(model) as Row[];
		const count = rows.length;
		const vectors = new Float32Array(count * dims);
		const promptRowids = new Int32Array(count);
		const ords = new Int32Array(count);
		const starts = new Int32Array(count);
		const ends = new Int32Array(count);
		let i = 0;
		for (const r of rows) {
			const blob = r['vec'] as Uint8Array;
			if (blob.byteLength !== dims * 4) {
				continue;
			}
			vectors.set(new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)), i * dims);
			promptRowids[i] = Number(r['pr']);
			ords[i] = Number(r['o']);
			starts[i] = Number(r['s']);
			ends[i] = Number(r['e']);
			i++;
		}
		return {
			dims, count: i, vectors: vectors.subarray(0, i * dims), promptRowids: promptRowids.subarray(0, i),
			ords: ords.subarray(0, i), starts: starts.subarray(0, i), ends: ends.subarray(0, i),
		};
	}

	/** Removes embeddings of this model that no chunk references any more (deleted/edited prompts). Other models' vectors are kept so switching back is free. */
	gcEmbeddings(model: string): number {
		return Number(this.stmt('DELETE FROM embeddings WHERE model = ? AND hash NOT IN (SELECT hash FROM chunks)').run(model).changes);
	}

	deleteEmbeddings(model: string): number {
		return Number(this.stmt('DELETE FROM embeddings WHERE model = ?').run(model).changes);
	}

	// ---- stats ----------------------------------------------------------------------------------

	counts(model: string | undefined): { sessions: number; prompts: number; chunks: number; embedded: number; byOrigin: Record<string, number>; bySource: Record<string, number> } {
		const one = (sql: string, ...args: (string | number)[]) => Number((this.db.prepare(sql).get(...args) as Row)['n']);
		const byOrigin: Record<string, number> = {};
		for (const r of this.stmt('SELECT origin, COUNT(*) AS n FROM prompts GROUP BY origin').all() as Row[]) {
			byOrigin[String(r['origin'])] = Number(r['n']);
		}
		const bySource: Record<string, number> = {};
		for (const r of this.stmt('SELECT s.source AS source, COUNT(*) AS n FROM prompts p JOIN sessions s ON s.key = p.session_key GROUP BY s.source').all() as Row[]) {
			bySource[String(r['source'])] = Number(r['n']);
		}
		return {
			sessions: one('SELECT COUNT(*) AS n FROM sessions WHERE key IN (SELECT DISTINCT session_key FROM prompts)'),
			prompts: one('SELECT COUNT(*) AS n FROM prompts'),
			chunks: one('SELECT COUNT(DISTINCT hash) AS n FROM chunks'),
			embedded: model ? one('SELECT COUNT(*) AS n FROM embeddings WHERE model = ? AND hash IN (SELECT hash FROM chunks)', model) : 0,
			byOrigin,
			bySource,
		};
	}
}

function n<T>(v: T | undefined): T | null {
	return v === undefined ? null : v;
}

/** A lease owned by a dead process on this machine can be taken over immediately; unknown owners are assumed alive. */
function isOwnerAlive(owner: string): boolean {
	const [host, pidStr] = owner.split(':');
	const pid = Number(pidStr);
	if (host !== os.hostname() || !Number.isInteger(pid) || pid <= 0) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function opt<T>(v: unknown): T | undefined {
	return v === null || v === undefined ? undefined : v as T;
}

function rowToPrompt(r: Row): StoredPrompt {
	return {
		rowid: Number(r['rowid']),
		id: String(r['id']),
		sessionKey: String(r['session_key']),
		text: String(r['text']),
		hash: String(r['hash']),
		timestamp: Number(r['ts']),
		origin: r['origin'] as PromptOrigin,
		seq: Number(r['seq']),
		model: opt<string>(r['model']),
	};
}

function rowToSession(r: Row): SessionInfo {
	return {
		key: String(r['key']),
		source: r['source'] as SourceKind,
		sessionId: String(r['session_id']),
		title: opt<string>(r['title']),
		cwd: opt<string>(r['cwd']),
		repository: opt<string>(r['repository']),
		repositoryInferred: Number(r['repo_inferred']) === 1 || undefined,
		workspaceless: Number(r['workspaceless']) === 1 || undefined,
		branch: opt<string>(r['branch']),
		client: opt<string>(r['client']),
		product: opt<string>(r['product']) ?? opt<string>(r['agent_host_product']),
		workspaceUri: opt<string>(r['workspace_uri']),
		agentHostSessionId: opt<string>(r['agent_host_session_id']),
		agentHostChatId: opt<string>(r['agent_host_chat_id']),
		createdAt: opt<number>(r['created_at']),
		updatedAt: opt<number>(r['updated_at']),
	};
}
