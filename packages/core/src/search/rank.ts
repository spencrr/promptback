/**
 * Pure ranking stages. Each takes plain data and returns plain data so it can be tested and reasoned about alone:
 *   allowedRows → lexicalHits / denseHits → fuse → (explore: matchSet | search: collapse + per-session cap)
 */
import type { PromptMeta, Store, VectorMatrix } from '../store.js';
import type { PromptOrigin, SearchFilters } from '../types.js';
import type { Corpus } from './corpus.js';
import { type ParsedQuery, isIdentifierish } from './query.js';

export interface RankingOptions {
	/** Reciprocal-rank-fusion constant. */
	readonly rrfK: number;
	/** Lexical weight for identifier-like or short (≤ 3 content tokens) queries. */
	readonly lexWeightHigh: number;
	/** Lexical weight for longer natural-language queries (dense dominates). */
	readonly lexWeightLow: number;
	/** The OR-query list gets this fraction of the lexical weight. */
	readonly orWeightFactor: number;
	/** Maximum multiplicative recency boost. */
	readonly recencyBoost: number;
	readonly recencyHalfLifeDays: number;
	/** Weight of the best chunk vs. the head chunk for multi-chunk prompts. */
	readonly maxChunkWeight: number;
	/** Quick search: hits shown per session before "+N more". */
	readonly maxPerSession: number;
	/** Explore: a semantic hit counts as a match when its similarity is this many standard deviations above the mean. */
	readonly semanticMatchZ: number;
	/** Explore: the best N fused results always count as matches. */
	readonly minMatches: number;
}

/** Parameters benchmarked on the real corpus (see docs/DESIGN.md). */
export const DEFAULT_RANKING: RankingOptions = {
	rrfK: 60,
	lexWeightHigh: 0.8,
	lexWeightLow: 0.2,
	orWeightFactor: 0.4,
	recencyBoost: 0.15,
	recencyHalfLifeDays: 30,
	maxChunkWeight: 0.5,
	maxPerSession: 3,
	semanticMatchZ: 2,
	minMatches: 20,
};

const DAY = 86_400_000;

// ---- 1. filtering -------------------------------------------------------------------------------------------------

export function allowedRows(corpus: Corpus, f: SearchFilters, defaults: { origins?: readonly PromptOrigin[]; includeAcks: boolean }): Set<number> {
	const originList = f.origins ?? defaults.origins;
	const origins = originList ? new Set(originList) : undefined;
	const includeAcks = f.includeAcks ?? defaults.includeAcks;
	const lc = (s: string | undefined) => s?.toLowerCase();
	const repo = lc(f.repo), branch = lc(f.branch), cwd = lc(f.cwd), client = lc(f.client), model = lc(f.model), sess = lc(f.sessionKey);
	const sessionOk = new Map<string, boolean>();
	const out = new Set<number>();
	for (const m of corpus.meta.values()) {
		if ((origins && !origins.has(m.origin)) || (m.isAck && !includeAcks)) {
			continue;
		}
		if ((f.after !== undefined && m.ts < f.after) || (f.before !== undefined && m.ts >= f.before)) {
			continue;
		}
		if (model && !lc(m.model)?.includes(model)) {
			continue;
		}
		let ok = sessionOk.get(m.sessionKey);
		if (ok === undefined) {
			const s = corpus.sessions.get(m.sessionKey);
			ok = !!s
				&& (!f.source || s.source === f.source)
				&& (!repo || !!(lc(s.repository) ?? lc(s.cwd))?.includes(repo))
				&& (!branch || !!lc(s.branch)?.includes(branch))
				&& (!cwd || !!(lc(s.cwd)?.includes(cwd) || lc(s.workspaceUri)?.includes(cwd)))
				&& (!client || !!lc(s.client)?.includes(client))
				&& (!sess || [s.key, s.sessionId, s.agentHostSessionId].some(v => !!v && lc(v)!.startsWith(sess)));
			sessionOk.set(m.sessionKey, ok);
		}
		if (ok) {
			out.add(m.rowid);
		}
	}
	return out;
}

// ---- 2a. lexical retrieval ----------------------------------------------------------------------------------------

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** All FTS hits (BM25 order) for: every term + phrase (`and`), any term (`or`). Unfiltered rowids. */
export function lexicalHits(store: Store, q: ParsedQuery): { and: number[]; or: number[] } {
	const must = [...q.terms.map(quote), ...q.phrases.map(quote)];
	const and = must.length ? store.searchFts(must.join(' AND ')).map(r => r.rowid) : [];
	let or: number[] = [];
	if (q.terms.length >= 2) {
		const any = `(${q.terms.map(quote).join(' OR ')})`;
		or = store.searchFts(q.phrases.length ? `${q.phrases.map(quote).join(' AND ')} AND ${any}` : any).map(r => r.rowid);
	}
	return { and, or };
}

/** Rows containing any excluded term (FTS semantics: tokenized, stemmed). */
export function excludedRows(store: Store, q: ParsedQuery): Set<number> {
	if (!q.excluded.length) {
		return new Set();
	}
	return new Set(store.searchFts(q.excluded.map(quote).join(' OR ')).map(r => r.rowid));
}

// ---- 2b. dense retrieval ------------------------------------------------------------------------------------------

export interface DenseHit {
	readonly rowid: number;
	readonly similarity: number;
	/** Best chunk, as UTF-16 offsets into the prompt. */
	readonly range: readonly [number, number];
}

/** Exact cosine over every embedded chunk of the allowed rows; prompt score = mix of best chunk and head chunk. */
export function denseHits(matrix: VectorMatrix, qv: Float32Array, allowed: ReadonlySet<number>, maxChunkWeight: number): DenseHit[] {
	const dims = matrix.dims;
	const best = new Map<number, { max: number; head?: number; range: [number, number] }>();
	for (let i = 0; i < matrix.count; i++) {
		const rowid = matrix.promptRowids[i]!;
		if (!allowed.has(rowid)) {
			continue;
		}
		let dot = 0;
		const off = i * dims;
		for (let d = 0; d < dims; d++) {
			dot += matrix.vectors[off + d]! * qv[d]!;
		}
		let b = best.get(rowid);
		if (!b) {
			b = { max: -Infinity, range: [matrix.starts[i]!, matrix.ends[i]!] };
			best.set(rowid, b);
		}
		if (dot > b.max) {
			b.max = dot;
			b.range = [matrix.starts[i]!, matrix.ends[i]!];
		}
		if (matrix.ords[i] === 0) {
			b.head = dot;
		}
	}
	const hits = [...best].map(([rowid, b]) => ({
		rowid,
		similarity: b.head === undefined ? b.max : maxChunkWeight * b.max + (1 - maxChunkWeight) * b.head,
		range: b.range,
	}));
	return hits.sort((a, b) => b.similarity - a.similarity);
}

// ---- 3. fusion ----------------------------------------------------------------------------------------------------

export interface Scored {
	readonly rowid: number;
	score: number;
	lexRank?: number;
	semRank?: number;
	similarity?: number;
	range?: readonly [number, number];
	/** Contains every term/phrase. */
	inAnd: boolean;
}

/**
 * Weighted reciprocal rank fusion. Lexical weight adapts to the query: identifier-like or short queries trust
 * keywords, longer natural-language queries trust embeddings (benchmark: equal weights hurt paraphrases badly).
 */
export function fuse(
	q: ParsedQuery,
	lex: { and: readonly number[]; or: readonly number[] } | undefined,
	dense: readonly DenseHit[] | undefined,
	allowed: ReadonlySet<number>,
	r: RankingOptions,
): Map<number, Scored> {
	const out = new Map<number, Scored>();
	const get = (rowid: number) => {
		let s = out.get(rowid);
		if (!s) {
			s = { rowid, score: 0, inAnd: false };
			out.set(rowid, s);
		}
		return s;
	};
	if (lex) {
		const wLex = isIdentifierish(q) || q.terms.length <= 3 ? r.lexWeightHigh : r.lexWeightLow;
		const lists: [readonly number[], number, boolean][] = [[lex.and, wLex, true], [lex.or, wLex * r.orWeightFactor, false]];
		for (const [list, w, isAnd] of lists) {
			let rank = 0;
			for (const rowid of list) {
				if (!allowed.has(rowid)) {
					continue;
				}
				rank++;
				const s = get(rowid);
				s.score += w / (r.rrfK + rank);
				s.lexRank = Math.min(s.lexRank ?? Infinity, rank);
				s.inAnd ||= isAnd;
			}
		}
	}
	dense?.forEach((d, i) => {
		const s = get(d.rowid);
		s.score += 1 / (r.rrfK + i + 1);
		s.semRank = i + 1;
		s.similarity = d.similarity;
		s.range = d.range;
	});
	return out;
}

/** Up to +`recencyBoost`, halving every `recencyHalfLifeDays`. */
export function applyRecency(scored: Iterable<Scored>, meta: ReadonlyMap<number, PromptMeta>, r: RankingOptions, now: number): void {
	const half = r.recencyHalfLifeDays * DAY;
	for (const s of scored) {
		const age = Math.max(0, now - meta.get(s.rowid)!.ts);
		s.score *= 1 + r.recencyBoost * Math.pow(2, -age / half);
	}
}

/** Mean and standard deviation of similarities, for the explore match threshold. */
export function similarityStats(dense: readonly DenseHit[]): { mean: number; std: number } {
	if (!dense.length) {
		return { mean: 0, std: 0 };
	}
	let sum = 0, sq = 0;
	for (const d of dense) {
		sum += d.similarity;
		sq += d.similarity * d.similarity;
	}
	const mean = sum / dense.length;
	return { mean, std: Math.sqrt(Math.max(0, sq / dense.length - mean * mean)) };
}

/** First occurrence of a phrase or term, for highlighting. */
export function lexicalRange(text: string, q: ParsedQuery): [number, number] | undefined {
	const lower = text.toLowerCase();
	for (const t of [...q.phrases.map(p => p.toLowerCase()), ...q.terms]) {
		const m = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').exec(lower);
		if (m) {
			return [m.index, m.index + t.length];
		}
	}
	return undefined;
}
