import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbeddingProvider } from './embed/index.js';
import { DEFAULT_LOCAL_MODEL } from './embed/models.js';
import type { EmbeddingConfig, EmbeddingProvider } from './embed/provider.js';
import { copilotHome as defaultCopilotHome, defaultIndexDir, vscodeUserDataRoots } from './paths.js';
import { type ChunkOptions, DEFAULT_CHUNK_OPTIONS, chunkText } from './search/chunk.js';
import { CorpusCache } from './search/corpus.js';
import { DEFAULT_RANKING, type RankingOptions, Searcher, wantsDense } from './search/searcher.js';
import { type AgentHostDbState, listAgentHostDbs, readAgentHostDb } from './sources/agentHost.js';
import { type CopilotFileState, copilotSessionKey, listCopilotSessions, readCopilotEvents, readCopilotSessionInfo } from './sources/copilot.js';
import { listChatSessionFiles, readChatSession } from './sources/vscodeChat.js';
import { type PromptMeta, Store, type StoredPrompt } from './store.js';
import type { ExploreResult, IndexStatus, PromptOrigin, PromptRecord, RecentSession, SearchQuery, SearchResult, SessionInfo, SyncProgress, SyncResult } from './types.js';

export interface EngineOptions {
	/** Directory for `index.db` and downloaded models. Shared by every window/process. */
	readonly indexDir?: string;
	/**
	 * Copilot home (`~/.copilot`); `null` disables the Copilot source.
	 * This, {@link vscodeChat} and {@link retainDeleted} are saved in the index whenever any of them is given (the VS Code
	 * extension always passes them). A process that passes none (the CLI and its MCP server) uses the saved values, so every
	 * process that syncs a shared index indexes the same sources and keeps the same deleted sessions.
	 */
	readonly copilotHome?: string | null;
	/** VS Code user-data roots; `null` disables VS Code chat + agent-host sources. */
	readonly vscodeRoots?: readonly { product: string; root: string }[] | null;
	/** Index VS Code Chat panel sessions (default true). Agents-window links are still resolved when false. */
	readonly vscodeChat?: boolean;
	readonly embedding?: EmbeddingConfig;
	/** A pre-built provider (takes precedence over `embedding`); useful for hosts and tests. */
	readonly embeddingProvider?: EmbeddingProvider;
	/** Extra read-only directories holding `<modelId>/...` (e.g. a model bundled with the extension). */
	readonly modelSearchDirs?: readonly string[];
	readonly allowModelDownload?: boolean;
	readonly modelMirror?: string;
	/** Which prompt origins get embeddings (others are lexical-only). */
	readonly embedOrigins?: readonly PromptOrigin[];
	readonly ranking?: Partial<RankingOptions>;
	readonly chunking?: Partial<ChunkOptions>;
	/** Keep prompts whose source session was deleted from disk. */
	readonly retainDeleted?: boolean;
	readonly log?: (message: string) => void;
}

export interface SyncOptions {
	readonly embed?: boolean;
	readonly signal?: AbortSignal;
	readonly onProgress?: (p: SyncProgress) => void;
}

const LEASE_TTL = 5 * 60_000;
const EMBED_BATCH = 64;

/** The source options saved in an index (see {@link EngineOptions.copilotHome}). */
interface SourceSettings {
	/** Absent = the default Copilot home; `null` = Copilot source off. */
	readonly copilotHome?: string | null;
	readonly vscodeChat: boolean;
	readonly retainDeleted: boolean;
}

/**
 * Transport-neutral facade over ingestion, indexing and search. The VS Code extension, the CLI and the MCP server
 * are thin adapters over this class.
 */
export class PromptSearchEngine {
	readonly store: Store;
	readonly indexDir: string;
	private readonly searcher: Searcher;
	private readonly corpus: CorpusCache;
	private provider: EmbeddingProvider | undefined;
	private providerPromise: Promise<EmbeddingProvider | undefined> | undefined;
	private providerError: string | undefined;
	private lastUse = Date.now();
	private readonly owner = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
	private readonly chunkOpts: ChunkOptions;
	private lastErrors: string[] = [];
	private embeddingPaused = false;
	private syncing: Promise<SyncResult> | undefined;
	/** Set when session metadata (title, repo, ...) was written, so search caches reload even without prompt changes. */
	private sessionsChanged = false;
	private readonly closing = new AbortController();

	private constructor(private readonly opts: EngineOptions) {
		this.indexDir = opts.indexDir ?? defaultIndexDir();
		this.store = new Store(path.join(this.indexDir, 'index.db'));
		this.chunkOpts = { ...DEFAULT_CHUNK_OPTIONS, ...opts.chunking };
		this.corpus = new CorpusCache(this.store, () => this.provider);
		this.searcher = new Searcher(this.store, this.corpus, () => this.provider, { ...DEFAULT_RANKING, ...opts.ranking });
	}

	static open(opts: EngineOptions = {}): PromptSearchEngine {
		return new PromptSearchEngine(opts);
	}

	private get embeddingConfig(): EmbeddingConfig {
		return this.opts.embedding ?? { kind: 'local', model: DEFAULT_LOCAL_MODEL };
	}

	private log(m: string): void {
		this.opts.log?.(m);
	}

	/** Lazily loads the embedding model. Failures degrade to lexical search and are reported in status. */
	ensureProvider(onProgress?: (message: string) => void): Promise<EmbeddingProvider | undefined> {
		this.lastUse = Date.now();
		if (this.provider) {
			return Promise.resolve(this.provider);
		}
		this.providerPromise ??= (async () => {
			try {
				const t = Date.now();
				const p = this.opts.embeddingProvider ?? await createEmbeddingProvider(this.embeddingConfig, {
					cacheDir: path.join(this.indexDir, 'models'),
					searchDirs: this.opts.modelSearchDirs,
					allowDownload: this.opts.allowModelDownload ?? true,
					mirror: this.opts.modelMirror,
					onProgress: m => {
						this.log(m);
						onProgress?.(m);
					},
				});
				this.provider = p;
				this.providerError = undefined;
				if (p) {
					this.store.setMeta('modelFingerprint', p.info.fingerprint);
					this.store.setMeta('modelName', p.info.displayName);
					this.store.setMeta('modelDims', String(p.info.dims));
					this.log(`Loaded embedding model ${p.info.displayName} in ${Date.now() - t} ms`);
				}
				return p;
			} catch (e) {
				this.providerError = `Embedding model unavailable: ${errMsg(e)}`;
				this.log(this.providerError);
				return undefined;
			} finally {
				this.providerPromise = undefined;
			}
		})();
		return this.providerPromise;
	}

	/** Frees the model and the in-memory corpus after a period without use; both are reloaded on demand. */
	async releaseIfIdle(idleMs: number): Promise<boolean> {
		if (this.syncing) {
			return false;
		}
		const corpusReleased = this.corpus.releaseIfIdle(idleMs);
		const p = this.provider;
		if (!p || this.opts.embeddingProvider || Date.now() - this.lastUse < idleMs) {
			return corpusReleased;
		}
		this.provider = undefined;
		await p.dispose();
		this.log('Released embedding model (idle)');
		return true;
	}

	/** Incrementally ingests all sources and embeds pending chunks. Concurrent calls share one run. */
	sync(opts: SyncOptions = {}): Promise<SyncResult> {
		this.syncing ??= this.doSync(opts).finally(() => (this.syncing = undefined));
		return this.syncing;
	}

	get isSyncing(): boolean {
		return !!this.syncing;
	}

	private async doSync(opts: SyncOptions): Promise<SyncResult> {
		const t0 = Date.now();
		const errors: string[] = [];
		let added = 0, removed = 0, embedded = 0;
		if (!this.store.tryAcquireLease(this.owner, LEASE_TTL)) {
			this.log('Another process is indexing; using its results.');
			return { addedPrompts: 0, removedPrompts: 0, embeddedChunks: 0, pendingChunks: 0, errors: [], tookMs: 0, leader: false };
		}
		try {
			opts.onProgress?.({ phase: 'scan', message: 'Scanning prompt history…' });
			const chunker = (text: string) => chunkText(text, this.chunkOpts);
			const sources = this.sourceSettings();

			const home = sources.copilotHome === undefined ? defaultCopilotHome() : sources.copilotHome;
			if (home) {
				const r = await this.syncCopilot(home, chunker, errors, sources.retainDeleted);
				added += r[0];
				removed += r[1];
			}
			const roots = this.opts.vscodeRoots === undefined ? vscodeUserDataRoots() : this.opts.vscodeRoots;
			if (roots) {
				if (sources.vscodeChat) {
					const r = await this.syncVscodeChat(roots, chunker, errors, sources.retainDeleted);
					added += r[0];
					removed += r[1];
				}
				await this.syncAgentHostLinks(roots, errors);
			}
			this.log(`Scanned sources in ${Date.now() - t0} ms (+${added} / -${removed} prompts)`);
			if (added || removed || this.sessionsChanged) {
				this.sessionsChanged = false;
				this.bumpRevision();
			}
			if (removed && this.provider) {
				this.store.gcEmbeddings(this.provider.info.fingerprint);
			}
			this.store.setMeta('lastSyncAt', String(Date.now()));

			if (opts.embed !== false) {
				embedded = await this.embedPending(opts, errors);
			}
			const p = this.provider;
			const pending = p ? this.store.countPendingChunks(p.info.fingerprint, this.embedOrigins) : 0;
			opts.onProgress?.({ phase: 'done', message: `Indexed: +${added} / -${removed} prompts, ${embedded} chunks embedded` });
			this.lastErrors = errors.slice(0, 50);
			return { addedPrompts: added, removedPrompts: removed, embeddedChunks: embedded, pendingChunks: pending, errors: this.lastErrors, tookMs: Date.now() - t0, leader: true };
		} finally {
			this.store.releaseLease(this.owner);
		}
	}

	private get embedOrigins(): readonly PromptOrigin[] {
		return this.opts.embedOrigins ?? ['human'];
	}

	/** Saves the source options when any are given; otherwise uses the saved ones (defaults for a new index). Call under the lease. */
	private sourceSettings(): SourceSettings {
		const { copilotHome, vscodeChat, retainDeleted } = this.opts;
		if (copilotHome !== undefined || vscodeChat !== undefined || retainDeleted !== undefined) {
			const given: SourceSettings = { copilotHome, vscodeChat: vscodeChat !== false, retainDeleted: retainDeleted === true };
			this.store.setMeta('sources', JSON.stringify(given));
			return given;
		}
		let saved: Partial<Record<keyof SourceSettings, unknown>> = {};
		try {
			saved = JSON.parse(this.store.getMeta('sources') ?? '{}') ?? {};
		} catch {
			// Unreadable: use the defaults.
		}
		return {
			copilotHome: typeof saved.copilotHome === 'string' || saved.copilotHome === null ? saved.copilotHome : undefined,
			vscodeChat: saved.vscodeChat !== false,
			retainDeleted: saved.retainDeleted === true,
		};
	}

	private bumpRevision(): void {
		this.store.setMeta('revision', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	}

	private async syncCopilot(home: string, chunker: (t: string) => ReturnType<typeof chunkText>, errors: string[], retainDeleted: boolean): Promise<[number, number]> {
		let added = 0, removed = 0;
		const sessions = listCopilotSessions(home);
		const seen = new Set<string>();
		const eventStates = this.store.loadFileStates<CopilotFileState>('copilot-events');
		const yamlStates = this.store.loadFileStates<{ mtimeMs: number }>('copilot-yaml');
		for (const [i, s] of sessions.entries()) {
			seen.add(s.eventsPath);
			try {
				const prev = eventStates.get(s.eventsPath);
				const res = readCopilotEvents(s, prev, home);
				const yamlMtime = mtime(s.yamlPath);
				const prevYaml = yamlStates.get(s.yamlPath);
				// v2: session metadata now includes derived repositories; re-read every yaml once.
				const yamlChanged = yamlMtime !== prevYaml?.mtimeMs || (prevYaml as { v?: number } | undefined)?.v !== 2;
				if (!res && !yamlChanged) {
					continue;
				}
				const hasPrompts = (res?.prompts.length ?? 0) > 0 || (prev?.seq ?? 0) > 0;
				this.store.transaction(() => {
					if (hasPrompts && (yamlChanged || res)) {
						this.store.upsertSession(readCopilotSessionInfo(s, res?.state ?? prev, home));
						this.sessionsChanged = true;
					}
					if (res) {
						if (res.reset && prev) {
							const [a, r] = this.store.replaceSessionPrompts(copilotSessionKey(s.sessionId), res.prompts, chunker);
							added += a;
							removed += r;
						} else {
							added += this.store.insertPrompts(res.prompts, chunker);
						}
						this.store.setFileState(s.eventsPath, 'copilot-events', res.state);
						if (res.oversized) {
							errors.push(`${s.eventsPath}: ${res.oversized} oversized prompt line(s) skipped`);
						}
					}
					this.store.setFileState(s.yamlPath, 'copilot-yaml', { mtimeMs: yamlMtime, v: 2 });
				});
			} catch (e) {
				errors.push(`${s.eventsPath}: ${errMsg(e)}`);
			}
			if (i % 25 === 0) {
				await yieldToLoop();
				if (this.closing.signal.aborted) {
					return [added, removed];
				}
			}
		}
		if (!retainDeleted) {
			for (const file of eventStates.keys()) {
				if (!seen.has(file) && !fs.existsSync(file)) {
					const sessionId = path.basename(path.dirname(file));
					removed += this.store.transaction(() => {
						this.store.deleteFile(file);
						this.store.deleteFile(path.join(path.dirname(file), 'workspace.yaml'));
						return this.store.deleteSession(copilotSessionKey(sessionId));
					});
				}
			}
		}
		return [added, removed];
	}

	private async syncVscodeChat(roots: readonly { product: string; root: string }[], chunker: (t: string) => ReturnType<typeof chunkText>, errors: string[], retainDeleted: boolean): Promise<[number, number]> {
		let added = 0, removed = 0;
		const seen = new Set<string>();
		const states = this.store.loadFileStates<{ size: number; mtimeMs: number; key: string; v?: number }>('vscode-chat');
		for (const { product, root } of roots) {
			for (const file of listChatSessionFiles(product, root)) {
				seen.add(file.path);
				try {
					const st = fs.statSync(file.path);
					const prev = states.get(file.path);
					if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.v === 2) {
						continue;
					}
					const { session, prompts } = readChatSession(file);
					this.store.transaction(() => {
						if (prompts.length) {
							this.store.upsertSession(session);
							this.sessionsChanged = true;
						}
						const [a, r] = this.store.replaceSessionPrompts(session.key, prompts, chunker);
						added += a;
						removed += r;
						this.store.setFileState(file.path, 'vscode-chat', { size: st.size, mtimeMs: st.mtimeMs, key: session.key, v: 2 });
					});
				} catch (e) {
					errors.push(`${file.path}: ${errMsg(e)}`);
				}
				await yieldToLoop();
				if (this.closing.signal.aborted) {
					return [added, removed];
				}
			}
		}
		if (!retainDeleted) {
			for (const [file, prev] of states) {
				if (!seen.has(file) && !fs.existsSync(file)) {
					removed += this.store.transaction(() => {
						this.store.deleteFile(file);
						return prev.key ? this.store.deleteSession(prev.key) : 0;
					});
				}
			}
		}
		return [added, removed];
	}

	/** Maps Copilot SDK session ids to Agents-window sessions (cached by db/wal mtime; cold read of ~1.4k dbs takes seconds). */
	private async syncAgentHostLinks(roots: readonly { product: string; root: string }[], errors: string[]): Promise<void> {
		const links: { sdkSessionId: string; agentHostSessionId: string; product: string; chatId?: string; title?: string }[] = [];
		let changed = false;
		const seen = new Set<string>();
		const states = this.store.loadFileStates<AgentHostDbState>('agent-host');
		for (const { product, root } of roots) {
			for (const [i, { agentHostSessionId, dbPath }] of listAgentHostDbs(root).entries()) {
				const m = Math.max(mtime(dbPath) ?? -1, mtime(`${dbPath}-wal`) ?? -1);
				if (m < 0) {
					continue;
				}
				seen.add(dbPath);
				let st = states.get(dbPath);
				if (!st || st.mtimeMs !== m) {
					try {
						st = { mtimeMs: m, size: 0, ...readAgentHostDb(dbPath) };
					} catch (e) {
						st = { mtimeMs: m, size: 0, links: [] };
						if (!/no such table/i.test(errMsg(e))) {
							errors.push(`${dbPath}: ${errMsg(e)}`);
						}
					}
					this.store.setFileState(dbPath, 'agent-host', st);
					changed = true;
				}
				for (const l of st.links) {
					links.push({ sdkSessionId: l.sdkSessionId, agentHostSessionId, product, chatId: l.chatId, title: st.title });
				}
				if (i % 50 === 0) {
					await yieldToLoop();
				}
			}
		}
		for (const file of states.keys()) {
			if (!seen.has(file)) {
				this.store.deleteFile(file);
				changed = true;
			}
		}
		if (changed) {
			this.store.transaction(() => this.store.replaceAgentHostLinks(links));
			this.bumpRevision();
		}
	}

	private async embedPending(opts: SyncOptions, errors: string[]): Promise<number> {
		const provider = await this.ensureProvider(m => opts.onProgress?.({ phase: 'embed', message: m }));
		if (!provider) {
			if (this.providerError) {
				errors.push(this.providerError);
			}
			return 0;
		}
		const fp = provider.info.fingerprint;
		const total = this.store.countPendingChunks(fp, this.embedOrigins);
		let done = 0;
		let sinceBump = 0;
		while (!opts.signal?.aborted && !this.closing.signal.aborted && !this.embeddingPaused) {
			const batch = this.store.pendingChunks(fp, this.embedOrigins, EMBED_BATCH);
			if (batch.length === 0) {
				break;
			}
			this.lastUse = Date.now();
			let vecs: Float32Array[];
			try {
				vecs = await provider.embedDocuments(batch.map(b => b.text));
			} catch (e) {
				errors.push(`Embedding failed: ${errMsg(e)}`);
				break;
			}
			this.store.transaction(() => this.store.saveEmbeddings(fp, batch.map((b, i) => ({ hash: b.hash, vector: vecs[i]! }))));
			done += batch.length;
			sinceBump += batch.length;
			if (sinceBump >= 256) {
				this.bumpRevision();
				sinceBump = 0;
				this.store.tryAcquireLease(this.owner, LEASE_TTL);
			}
			opts.onProgress?.({ phase: 'embed', message: `Embedding prompts ${done}/${total}`, done, total });
		}
		if (done) {
			this.bumpRevision();
		}
		return done;
	}

	/** Quick search (top hits, collapsed, capped per session). Waits ≤ 3 s for a cold model, then falls back to keywords. */
	async search(query: SearchQuery | string): Promise<SearchResult> {
		const q = typeof query === 'string' ? { text: query } : query;
		// Keyword-only and browse queries never load the model (~100 MB).
		if (wantsDense(q.text, q.mode)) {
			await this.warm(3000);
		}
		this.lastUse = Date.now();
		return this.searcher.search(query);
	}

	/** Every matching prompt occurrence for the Explorer (an empty query lists everything, newest first). */
	async explore(query: string): Promise<ExploreResult> {
		if (wantsDense(query)) {
			await this.warm(3000);
		}
		this.lastUse = Date.now();
		return this.searcher.explore(query);
	}

	/** Starts loading the embedding model; resolves when loaded or after `maxWaitMs`. */
	async warm(maxWaitMs = 0): Promise<void> {
		if (this.provider || this.embeddingConfig.kind === 'none') {
			return;
		}
		const loading = this.ensureProvider();
		if (maxWaitMs > 0) {
			await Promise.race([loading, new Promise(r => setTimeout(r, maxWaitMs))]);
		}
	}

	getPrompt(id: string): { prompt: StoredPrompt; session?: SessionInfo } | undefined {
		const prompt = this.store.getPrompt(id);
		if (!prompt) {
			return undefined;
		}
		return { prompt, session: this.corpus.get().sessions.get(prompt.sessionKey) };
	}

	getSessionPrompts(sessionKey: string): PromptRecord[] {
		return this.store.getSessionPrompts(sessionKey);
	}

	/** Sessions whose key, native id or Agents-window id equals `id` (case-insensitive), else starts with it. */
	findSessions(id: string): SessionInfo[] {
		const q = id.trim().toLowerCase();
		if (!q) {
			return [];
		}
		const all = [...this.corpus.get().sessions.values()];
		const ids = (s: SessionInfo) => [s.key, s.sessionId, s.agentHostSessionId].flatMap(v => (v ? [v.toLowerCase()] : []));
		const exact = all.filter(s => ids(s).includes(q));
		return exact.length ? exact : all.filter(s => ids(s).some(v => v.startsWith(q)));
	}

	get modelLoaded(): boolean {
		return !!this.provider;
	}

	/** Most recently active sessions with your own prompts (newest first), for the sidebar. */
	recentSessions(limit = 50, promptsPerSession = 20): RecentSession[] {
		const corpus = this.corpus.get();
		const bySession = new Map<string, PromptMeta[]>();
		for (const m of corpus.meta.values()) {
			if (m.origin === 'human' && !m.isAck) {
				(bySession.get(m.sessionKey) ?? bySession.set(m.sessionKey, []).get(m.sessionKey)!).push(m);
			}
		}
		const recent = [...bySession]
			.map(([key, list]) => ({ key, list, last: Math.max(...list.map(m => m.ts)) }))
			.sort((a, b) => b.last - a.last)
			.slice(0, limit);
		const previews = this.store.getPreviews(recent.flatMap(r => r.list.map(m => m.rowid)), 160);
		return recent.map(({ key, list, last }) => ({
			session: corpus.sessions.get(key) ?? { key, source: 'copilot', sessionId: key },
			promptCount: list.length,
			lastActivity: last,
			prompts: list.sort((a, b) => a.seq - b.seq).slice(-promptsPerSession)
				.map(m => ({ id: m.id, timestamp: m.ts, preview: previews.get(m.rowid) ?? '' })),
		}));
	}

	/** Pauses or resumes background embedding (keyword search keeps working). */
	setEmbeddingPaused(paused: boolean): void {
		this.embeddingPaused = paused;
		this.log(paused ? 'Embedding paused' : 'Embedding resumed');
	}

	/** Drops this model's vectors so the next sync re-embeds everything (e.g. after changing chunking). */
	async rebuildEmbeddings(): Promise<void> {
		await this.syncing?.catch(() => undefined);
		const fp = this.provider?.info.fingerprint ?? this.store.getMeta('modelFingerprint');
		if (fp) {
			this.store.deleteEmbeddings(fp);
			this.bumpRevision();
		}
	}

	status(): IndexStatus {
		const fp = this.provider?.info.fingerprint ?? this.store.getMeta('modelFingerprint');
		const c = this.store.counts(fp);
		const pending = fp ? this.store.countPendingChunks(fp, this.embedOrigins) : c.chunks;
		const last = this.store.getMeta('lastSyncAt');
		let indexBytes = 0;
		for (const suffix of ['', '-wal']) {
			indexBytes += fs.statSync(this.store.file + suffix, { throwIfNoEntry: false })?.size ?? 0;
		}
		return {
			indexPath: this.store.file,
			indexBytes,
			sessions: c.sessions,
			prompts: c.prompts,
			promptsByOrigin: c.byOrigin,
			promptsBySource: c.bySource,
			chunks: c.embedded + pending,
			embeddedChunks: c.embedded,
			pendingChunks: pending,
			embeddingPaused: this.embeddingPaused,
			model: this.provider?.info.displayName ?? this.store.getMeta('modelName'),
			modelLoaded: !!this.provider,
			lastSyncAt: last ? Number(last) : undefined,
			errors: [...(this.providerError ? [this.providerError] : []), ...this.lastErrors],
		};
	}

	/** Stops any running sync (it finishes its current batch and releases the writer lease), then frees resources. */
	async close(): Promise<void> {
		this.closing.abort();
		await this.syncing?.catch(() => undefined);
		await this.provider?.dispose();
		this.provider = undefined;
		this.store.close();
	}
}

function mtime(p: string): number | undefined {
	try {
		return fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs;
	} catch {
		return undefined;
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function yieldToLoop(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}
