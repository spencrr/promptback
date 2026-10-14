import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider } from './embed/provider.js';
import { type EmbeddingConfig, NO_EMBEDDING, createEmbeddingProvider } from './embed/registry.js';
import { defaultIndexDir } from './paths.js';
import { type PluginOptionsError, type Registry, parseOptions } from './registry.js';
import { type ChunkOptions, DEFAULT_CHUNK_OPTIONS, chunkText } from './search/chunk.js';
import { CorpusCache } from './search/corpus.js';
import { DEFAULT_RANKING, type RankingOptions, Searcher, wantsDense } from './search/searcher.js';
import type { PromptSourcePlugin, SourceContext } from './sources/base.js';
import { promptSources } from './sources/registry.js';
import { type PromptMeta, Store, type StoredPrompt } from './store.js';
import type { ExploreResult, IndexStatus, PromptOrigin, PromptRecord, RecentSession, SearchQuery, SearchResult, SessionInfo, SyncProgress, SyncResult } from './types.js';
import { errorMessage, yieldToLoop } from './util/fs.js';

/** Per-source options by source id, each validated by that source's schema (`enabled` is common to all). */
export type SourceOptionsById = Readonly<Record<string, unknown>>;

export interface EngineOptions {
	/** Directory for `index.db` and downloaded models. Shared by every window/process. */
	readonly indexDir?: string;
	/**
	 * Options per prompt source (`copilot`, `vscode-chat`, `agent-host`, `claude-code`, `codex`, ...). Sources not
	 * listed use their defaults (enabled). When given, this and {@link retainDeleted} are saved in the index (the VS Code
	 * extension always passes them); a process that passes neither (the CLI and its MCP server) uses the saved values, so
	 * every process that syncs a shared index indexes the same sources and keeps the same deleted sessions.
	 */
	readonly sources?: SourceOptionsById;
	/** Keep prompts whose source session was deleted from disk. */
	readonly retainDeleted?: boolean;
	/** Which sources exist; defaults to the global registry with the built-ins. */
	readonly sourceRegistry?: Registry<PromptSourcePlugin>;
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
	readonly log?: (message: string) => void;
}

export interface SyncOptions {
	readonly embed?: boolean;
	readonly signal?: AbortSignal;
	readonly onProgress?: (p: SyncProgress) => void;
}

const LEASE_TTL = 5 * 60_000;
const EMBED_BATCH = 64;

/** What `meta.sources` holds. Version 2; version 1 (`{ copilotHome, vscodeChat, retainDeleted }`) is still read. */
interface SourceSettings {
	readonly v: 2;
	readonly retainDeleted: boolean;
	readonly sources: SourceOptionsById;
}

interface LegacySourceSettings {
	readonly copilotHome?: string | null;
	readonly vscodeChat?: boolean;
	readonly retainDeleted?: boolean;
}

/** Maps the version-1 shape onto per-source options. */
export function migrateSourceSettings(saved: unknown): SourceSettings {
	if (!saved || typeof saved !== 'object') {
		return { v: 2, retainDeleted: false, sources: {} };
	}
	const s = saved as Partial<SourceSettings> & LegacySourceSettings;
	if (s.v === 2 && s.sources && typeof s.sources === 'object') {
		return { v: 2, retainDeleted: s.retainDeleted === true, sources: s.sources };
	}
	const sources: Record<string, unknown> = {};
	if (s.copilotHome === null) {
		sources['copilot'] = { enabled: false };
	} else if (typeof s.copilotHome === 'string') {
		sources['copilot'] = { home: s.copilotHome };
	}
	if (s.vscodeChat === false) {
		sources['vscode-chat'] = { enabled: false };
	}
	return { v: 2, retainDeleted: s.retainDeleted === true, sources };
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
	private readonly closing = new AbortController();
	private readonly sources: Registry<PromptSourcePlugin>;

	private constructor(private readonly opts: EngineOptions) {
		this.indexDir = opts.indexDir ?? defaultIndexDir();
		this.store = new Store(path.join(this.indexDir, 'index.db'));
		this.chunkOpts = { ...DEFAULT_CHUNK_OPTIONS, ...opts.chunking };
		this.sources = opts.sourceRegistry ?? promptSources;
		this.corpus = new CorpusCache(this.store, () => this.provider);
		this.searcher = new Searcher(this.store, this.corpus, () => this.provider, { ...DEFAULT_RANKING, ...opts.ranking });
	}

	static open(opts: EngineOptions = {}): PromptSearchEngine {
		return new PromptSearchEngine(opts);
	}

	private get embeddingConfig(): EmbeddingConfig {
		return this.opts.embedding ?? { kind: 'local' };
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
				this.providerError = `Embedding model unavailable: ${errorMessage(e)}`;
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
		let added = 0;
		let removed = 0;
		let embedded = 0;
		if (!this.store.tryAcquireLease(this.owner, LEASE_TTL)) {
			this.log('Another process is indexing; using its results.');
			return { addedPrompts: 0, removedPrompts: 0, embeddedChunks: 0, pendingChunks: 0, errors: [], tookMs: 0, leader: false };
		}
		try {
			opts.onProgress?.({ phase: 'scan', message: 'Scanning prompt history…' });
			const settings = this.sourceSettings();
			const ctx: SourceContext = {
				store: this.store,
				chunker: (text: string) => chunkText(text, this.chunkOpts),
				retainDeleted: settings.retainDeleted,
				signal: this.closing.signal,
				log: m => this.log(m),
				yieldToLoop,
			};
			let sessionsChanged = false;
			for (const source of this.sources.list()) {
				if (this.closing.signal.aborted) {
					break;
				}
				let options: { enabled: boolean };
				try {
					options = parseOptions(this.sources.kind, source, settings.sources[source.id]) as { enabled: boolean };
				} catch (e) {
					errors.push((e as PluginOptionsError).message);
					continue;
				}
				if (!options.enabled) {
					continue;
				}
				const t = Date.now();
				try {
					const r = await source.sync(options, ctx);
					added += r.added;
					removed += r.removed;
					sessionsChanged ||= r.sessionsChanged;
					errors.push(...r.errors);
					if (r.added || r.removed || r.sessionsChanged) {
						this.log(`${source.label}: +${r.added} / -${r.removed} prompts in ${Date.now() - t} ms`);
					}
				} catch (e) {
					errors.push(`${source.label}: ${errorMessage(e)}`);
				}
			}
			this.log(`Scanned sources in ${Date.now() - t0} ms (+${added} / -${removed} prompts)`);
			if (added || removed || sessionsChanged) {
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

	/**
	 * Saves the source options when any are given; otherwise uses the saved ones (defaults for a new index). Call under
	 * the lease. Options for sources this build does not know are kept, so an older and a newer build can share an index.
	 */
	private sourceSettings(): SourceSettings {
		const { sources, retainDeleted } = this.opts;
		if (sources !== undefined || retainDeleted !== undefined) {
			const given: SourceSettings = { v: 2, retainDeleted: retainDeleted === true, sources: sources ?? {} };
			this.store.setMeta('sources', JSON.stringify(given));
			return given;
		}
		let saved: unknown;
		try {
			saved = JSON.parse(this.store.getMeta('sources') ?? '{}');
		} catch {
			// Unreadable: use the defaults.
		}
		return migrateSourceSettings(saved);
	}

	/** The source plugins and the options they would run with (validated), for status displays. */
	describeSources(): { readonly id: string; readonly label: string; readonly enabled: boolean; readonly options: unknown; readonly error?: string }[] {
		const settings = this.sourceSettings();
		return this.sources.list().map(source => {
			try {
				const options = parseOptions(this.sources.kind, source, settings.sources[source.id]) as { enabled: boolean };
				return { id: source.id, label: source.label, enabled: options.enabled, options };
			} catch (e) {
				return { id: source.id, label: source.label, enabled: false, options: settings.sources[source.id], error: errorMessage(e) };
			}
		});
	}
	private bumpRevision(): void {
		this.store.setMeta('revision', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
				errors.push(`Embedding failed: ${errorMessage(e)}`);
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
		if (this.provider || this.embeddingConfig.kind === NO_EMBEDDING) {
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
