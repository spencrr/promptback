import * as os from 'node:os';
import type { EmbeddingProvider } from '../embed/provider.js';
import type { Store } from '../store.js';
import type {
	ExploreResult,
	ExploreRow,
	SearchFilters,
	SearchHit,
	SearchMode,
	SearchQuery,
	SearchResult,
	SessionInfo,
} from '../types.js';
import { ALL_ORIGINS } from '../types.js';
import type { Corpus, CorpusCache } from './corpus.js';
import { type ParsedQuery, parseQuery } from './query.js';
import {
	allowedRows,
	applyRecency,
	DEFAULT_RANKING,
	denseHits,
	excludedRows,
	fuse,
	lexicalHits,
	lexicalRange,
	type RankingOptions,
	type Scored,
	similarityStats,
} from './rank.js';
import { clusterTopics } from './topics.js';

export { DEFAULT_RANKING, type RankingOptions } from './rank.js';

const PREVIEW_CHARS = 240;
const TOPIC_CANDIDATES = 150;
/** Words that appear in many prompts' paths and say nothing about the topic. */
const USER_WORDS = [os.userInfo().username.toLowerCase()];

/** Whether a query uses semantic retrieval (and so the embedding model): it has free text and isn't keyword-only. */
export function wantsDense(text: string, requestedMode?: SearchMode): boolean {
	return isDense(parseQuery(text), requestedMode);
}

function isDense(parsed: ParsedQuery, requestedMode: SearchMode | undefined): boolean {
	return (parsed.mode ?? requestedMode ?? 'hybrid') !== 'lexical' && parsed.freeText.length > 0;
}

interface Ranked {
	readonly corpus: Corpus;
	readonly parsed: ParsedQuery;
	readonly filters: SearchFilters;
	readonly mode: SearchMode;
	readonly semanticUnavailable: boolean;
	/** Best first. Browse queries (no free text) are newest first with score 0. */
	readonly scored: Scored[];
	readonly isBrowse: boolean;
	/** Explore match threshold on similarity (undefined when dense retrieval didn't run). */
	readonly semanticCutoff?: number;
}

/** Ranks queries against the cached corpus. `search` serves the quick picker, `explore` the full Explorer. */
export class Searcher {
	private readonly queryVectors = new Map<string, Float32Array>();

	constructor(
		private readonly store: Store,
		private readonly corpus: CorpusCache,
		private readonly provider: () => EmbeddingProvider | undefined,
		private readonly ranking: RankingOptions = DEFAULT_RANKING,
	) {}

	/** Quick search: top results, identical texts collapsed, at most `maxPerSession` per session. */
	async search(query: SearchQuery | string, now = Date.now()): Promise<SearchResult> {
		const t0 = performance.now();
		const q: SearchQuery = typeof query === 'string' ? { text: query } : query;
		const limit = q.limit ?? 50;
		const r = await this.rank({
			text: q.text,
			filters: q.filters,
			mode: q.mode,
			defaults: { origins: ['human'], includeAcks: false },
			now,
		});

		const collapse = q.collapseDuplicates !== false;
		const cap =
			r.parsed.sort === 'recent' || r.isBrowse || r.filters.sessionKey
				? Number.POSITIVE_INFINITY
				: this.ranking.maxPerSession;
		const groups = new Map<string, { head: Scored; dups: Scored[]; more: number }>();
		const perSession = new Map<string, { shown: number; lastGroup?: { more: number } }>();
		const picked: { head: Scored; dups: Scored[]; more: number }[] = [];
		for (const s of r.scored) {
			const m = r.corpus.meta.get(s.rowid)!;
			const dupOf = collapse ? groups.get(m.hash) : undefined;
			if (dupOf) {
				dupOf.dups.push(s);
				continue;
			}
			const ps = perSession.get(m.sessionKey) ?? { shown: 0 };
			perSession.set(m.sessionKey, ps);
			if (ps.shown >= cap) {
				if (ps.lastGroup) {
					ps.lastGroup.more++;
				}
				continue;
			}
			ps.shown++;
			const g = { head: s, dups: [] as Scored[], more: 0 };
			ps.lastGroup = g;
			groups.set(m.hash, g);
			if (picked.length < limit) {
				picked.push(g);
			}
		}

		const prompts = this.store.getPromptsByRowid(picked.map(g => g.head.rowid));
		const hits: SearchHit[] = [];
		for (const g of picked) {
			const prompt = prompts.get(g.head.rowid);
			if (!prompt) {
				continue;
			}
			hits.push({
				prompt,
				session: r.corpus.sessions.get(prompt.sessionKey) ?? {
					key: prompt.sessionKey,
					source: 'copilot',
					sessionId: prompt.sessionKey,
				},
				score: g.head.score,
				lexicalRank: g.head.lexRank,
				semanticRank: g.head.semRank,
				matchRange: (g.head.lexRank ? lexicalRange(prompt.text, r.parsed) : undefined) ?? g.head.range,
				duplicates: g.dups.map(d => {
					const dm = r.corpus.meta.get(d.rowid)!;
					return { promptId: dm.id, sessionKey: dm.sessionKey, timestamp: dm.ts };
				}),
				moreInSession: g.more,
			});
		}
		return {
			query: q.text,
			freeText: r.parsed.freeText,
			filters: r.filters,
			mode: r.mode,
			semanticUnavailable: r.semanticUnavailable,
			hits,
			tookMs: Math.round(performance.now() - t0),
		};
	}

	/**
	 * Explorer: every matching occurrence (no per-session cap, no collapsing) so the client can sort, facet and group
	 * exactly. A row matches if it contains every term, is semantically close (z-score cutoff), or is in the top N.
	 * An empty query returns every prompt, newest first.
	 */
	async explore(text: string, now = Date.now()): Promise<ExploreResult> {
		const t0 = performance.now();
		const r = await this.rank({ text, defaults: { origins: ALL_ORIGINS, includeAcks: true }, now });
		let matched = r.scored;
		if (!r.isBrowse) {
			const cutoff = r.semanticCutoff ?? Number.POSITIVE_INFINITY;
			matched = r.scored.filter(
				(s, i) =>
					s.inAnd || (s.similarity ?? Number.NEGATIVE_INFINITY) >= cutoff || i < this.ranking.minMatches,
			);
		}

		const needText = !r.isBrowse;
		const texts = needText ? this.store.getPromptsByRowid(matched.map(s => s.rowid)) : undefined;
		const previews = needText
			? undefined
			: this.store.getPreviews(
					matched.map(s => s.rowid),
					PREVIEW_CHARS,
				);
		const rows: ExploreRow[] = [];
		const sessions: Record<string, SessionInfo> = {};
		const cutoff = r.semanticCutoff ?? Number.POSITIVE_INFINITY;
		for (const s of matched) {
			const m = r.corpus.meta.get(s.rowid)!;
			const full = texts?.get(s.rowid)?.text;
			const preview = full === undefined ? previews?.get(s.rowid) : full.slice(0, PREVIEW_CHARS);
			if (preview === undefined) {
				continue;
			}
			const range =
				full === undefined
					? undefined
					: ((s.inAnd || s.lexRank ? lexicalRange(full, r.parsed) : undefined) ?? s.range);
			rows.push({
				id: m.id,
				sessionKey: m.sessionKey,
				preview,
				snippet:
					full !== undefined && range && range[0] > PREVIEW_CHARS - 40 ? excerpt(full, range) : undefined,
				timestamp: m.ts,
				origin: m.origin,
				length: full?.length ?? m.length,
				hash: m.hash,
				isAck: m.isAck,
				model: m.model,
				seq: m.seq,
				score: s.score,
				similarity: s.similarity,
				matchedLexical: s.inAnd,
				matchedSemantic: (s.similarity ?? Number.NEGATIVE_INFINITY) >= cutoff,
				matchRange: range,
			});
			sessions[m.sessionKey] ??= r.corpus.sessions.get(m.sessionKey) ?? {
				key: m.sessionKey,
				source: 'copilot',
				sessionId: m.sessionKey,
			};
		}
		const { topics, topicOf } = this.topicsFor(r, matched, texts);
		return {
			query: text,
			freeText: r.parsed.freeText,
			mode: r.mode,
			semanticUnavailable: r.semanticUnavailable,
			revision: r.corpus.revision,
			rows: rows.map(row => ({ ...row, topic: topicOf.get(row.hash) })),
			sessions,
			topics,
			tookMs: Math.round(performance.now() - t0),
		};
	}

	/**
	 * Clusters the best distinct prompts (your own prompts first) into topics. Rows sharing a text share its topic;
	 * rows without an embedding or beyond the cap stay unclustered.
	 */
	private topicsFor(r: Ranked, matched: readonly Scored[], texts: ReadonlyMap<number, { text: string }> | undefined) {
		const topicOf = new Map<string, number>();
		const m = r.corpus.matrix;
		if (!m?.count) {
			return { topics: [], topicOf };
		}
		const isOwn = (s: Scored) => {
			const meta = r.corpus.meta.get(s.rowid)!;
			return meta.origin === 'human' && !meta.isAck;
		};
		const picked: Scored[] = [];
		const hashes = new Set<string>();
		for (const s of [...matched.filter(isOwn), ...matched.filter(x => !isOwn(x))]) {
			const hash = r.corpus.meta.get(s.rowid)!.hash;
			if (picked.length >= TOPIC_CANDIDATES || hashes.has(hash) || !r.corpus.heads.has(s.rowid)) {
				continue;
			}
			hashes.add(hash);
			picked.push(s);
		}
		const full = texts ?? this.store.getPromptsByRowid(picked.map(s => s.rowid));
		const vectors = picked.map(s => {
			const i = r.corpus.heads.get(s.rowid)!;
			return m.vectors.subarray(i * m.dims, (i + 1) * m.dims);
		});
		const result = clusterTopics(
			vectors,
			picked.map(s => full.get(s.rowid)?.text ?? ''),
			{
				exclude: [...r.parsed.terms, ...USER_WORDS],
				vocabulary: r.corpus.vocabulary(),
			},
		);
		for (const [i, s] of picked.entries()) {
			topicOf.set(r.corpus.meta.get(s.rowid)!.hash, result.assignment[i]!);
		}
		return { topics: result.topics, topicOf };
	}

	/** Shared pipeline: parse → filter → retrieve (lexical, dense) → fuse → recency. */
	private async rank(req: {
		readonly text: string;
		readonly filters?: SearchFilters;
		readonly mode?: SearchMode;
		readonly defaults: Parameters<typeof allowedRows>[2];
		readonly now: number;
	}): Promise<Ranked> {
		const { text, filters: extraFilters, mode: requestedMode, defaults, now } = req;
		const corpus = this.corpus.get();
		const parsed = parseQuery(text, now);
		const filters: SearchFilters = { ...extraFilters, ...parsed.filters };
		const mode = parsed.mode ?? requestedMode ?? 'hybrid';
		let allowed = allowedRows(corpus, filters, defaults);
		const excluded = excludedRows(this.store, parsed);
		if (excluded.size > 0) {
			allowed = new Set([...allowed].filter(id => !excluded.has(id)));
		}

		const provider = this.provider();
		const denseReady = Boolean(provider) && Boolean(corpus.matrix?.count);
		const wantDense = isDense(parsed, requestedMode);
		const hasLexical = parsed.terms.length > 0 || parsed.phrases.length > 0;
		const base = { corpus, parsed, filters, mode, semanticUnavailable: wantDense && !denseReady };

		if (!hasLexical && !parsed.freeText) {
			const scored = [...allowed]
				.sort((a, b) => corpus.meta.get(b)!.ts - corpus.meta.get(a)!.ts)
				.map(rowid => ({ rowid, score: 0, inAnd: false }));
			return { ...base, scored, isBrowse: true };
		}

		if (parsed.phrases.length > 0) {
			const withPhrases = new Set(lexicalHits(this.store, { ...parsed, terms: [] }).and);
			allowed = new Set([...allowed].filter(id => withPhrases.has(id)));
		}
		const lex = hasLexical && (mode !== 'semantic' || !denseReady) ? lexicalHits(this.store, parsed) : undefined;
		const dense =
			wantDense && denseReady
				? denseHits(
						corpus.matrix!,
						await this.embedQuery(provider!, parsed.freeText),
						allowed,
						this.ranking.maxChunkWeight,
					)
				: undefined;
		const fused = fuse(parsed, { lex, dense, allowed }, this.ranking);

		const scored = [...fused.values()];
		if (parsed.sort === 'recent') {
			for (const s of scored) {
				s.score = corpus.meta.get(s.rowid)!.ts;
			}
		} else {
			applyRecency(scored, corpus.meta, this.ranking, now);
		}
		scored.sort((a, b) => b.score - a.score || corpus.meta.get(b.rowid)!.ts - corpus.meta.get(a.rowid)!.ts);

		let semanticCutoff: number | undefined;
		if (dense?.length) {
			const { mean, std } = similarityStats(dense);
			semanticCutoff = mean + this.ranking.semanticMatchZ * std;
		}
		return { ...base, scored, isBrowse: false, semanticCutoff };
	}

	private async embedQuery(provider: EmbeddingProvider, text: string): Promise<Float32Array> {
		const key = `${provider.info.fingerprint}\n${text}`;
		let v = this.queryVectors.get(key);
		if (!v) {
			v = await provider.embedQuery(text);
			this.queryVectors.set(key, v);
			if (this.queryVectors.size > 64) {
				this.queryVectors.delete(this.queryVectors.keys().next().value!);
			}
		}
		return v;
	}
}

function excerpt(text: string, [start, end]: readonly [number, number]): string {
	const from = Math.max(0, start - 80);
	return `${from > 0 ? '…' : ''}${text
		.slice(from, Math.max(end, from + 240))
		.replace(/\s+/g, ' ')
		.trim()}…`;
}
