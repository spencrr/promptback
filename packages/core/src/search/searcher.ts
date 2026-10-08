import type { EmbeddingProvider } from '../embed/provider.js';
import type { PromptMeta, Store, VectorMatrix } from '../store.js';
import type { PromptOrigin, SearchHit, SearchMode, SearchQuery, SearchResult, SessionInfo } from '../types.js';
import { type ParsedFilters, type ParsedQuery, isIdentifierish, parseQuery } from './query.js';

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
	readonly maxPerSession: number;
	readonly candidateLimit: number;
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
	candidateLimit: 300,
};

const DAY = 86_400_000;

interface Candidate {
	rowid: number;
	score: number;
	lexRank?: number;
	semRank?: number;
	range?: [number, number];
}

/** Holds in-memory caches (prompt metadata, sessions, vectors) and ranks queries against them. */
export class Searcher {
	private revision: string | undefined;
	private fingerprint: string | undefined;
	private meta = new Map<number, PromptMeta>();
	private sessions = new Map<string, SessionInfo>();
	private matrix: VectorMatrix | undefined;

	constructor(
		private readonly store: Store,
		private readonly provider: () => EmbeddingProvider | undefined,
		private readonly ranking: RankingOptions = DEFAULT_RANKING,
	) { }

	/** Reloads caches when the index or the active model changed. */
	refresh(force = false): void {
		const rev = this.store.getMeta('revision') ?? '0';
		const p = this.provider();
		const fp = p?.info.fingerprint;
		if (!force && rev === this.revision && fp === this.fingerprint) {
			return;
		}
		this.meta = new Map(this.store.listPromptMeta().map(m => [m.rowid, m]));
		this.sessions = new Map(this.store.listAllSessions().map(s => [s.key, s]));
		this.matrix = p && p.info.dims ? this.store.loadVectorMatrix(p.info.fingerprint, p.info.dims) : undefined;
		this.revision = rev;
		this.fingerprint = fp;
	}

	get embeddedCount(): number {
		return this.matrix?.count ?? 0;
	}

	async search(query: SearchQuery | string, now = Date.now()): Promise<SearchResult> {
		const t0 = performance.now();
		const q: SearchQuery = typeof query === 'string' ? { text: query } : query;
		this.refresh();
		const parsed = parseQuery(q.text, now);
		const filters: ParsedFilters = { ...q.filters, ...parsed.filters };
		const mode: SearchMode = parsed.mode ?? q.mode ?? 'hybrid';
		const limit = q.limit ?? 50;
		const allowed = this.allowedRowids(filters);
		const hasText = parsed.terms.length > 0 || parsed.phrases.length > 0;
		const provider = this.provider();
		const denseReady = !!provider && !!this.matrix && this.matrix.count > 0;
		const wantDense = mode !== 'lexical' && parsed.freeText.length > 0;
		const semanticUnavailable = wantDense && !denseReady;

		const cands = new Map<number, Candidate>();
		const get = (rowid: number) => {
			let c = cands.get(rowid);
			if (!c) {
				c = { rowid, score: 0 };
				cands.set(rowid, c);
			}
			return c;
		};
		const k = this.ranking.rrfK;

		if (!hasText && !parsed.freeText) {
			// Filter-only query: newest first.
			for (const rowid of allowed) {
				get(rowid).score = this.meta.get(rowid)!.ts;
			}
		} else {
			const useLex = mode !== 'semantic' || !denseReady;
			const short = parsed.terms.length <= 3;
			const wLex = (isIdentifierish(parsed) || short) ? this.ranking.lexWeightHigh : this.ranking.lexWeightLow;
			if (useLex && hasText) {
				const lists: [string | undefined, number][] = [
					[ftsAnd(parsed), wLex],
					[ftsOr(parsed), wLex * this.ranking.orWeightFactor],
				];
				for (const [expr, w] of lists) {
					if (!expr) {
						continue;
					}
					let rank = 0;
					for (const r of this.store.searchFts(expr, this.ranking.candidateLimit * 2)) {
						if (!allowed.has(r.rowid)) {
							continue;
						}
						rank++;
						const c = get(r.rowid);
						c.score += w / (k + rank);
						c.lexRank = Math.min(c.lexRank ?? Infinity, rank);
						if (rank >= this.ranking.candidateLimit) {
							break;
						}
					}
				}
			}
			if (wantDense && denseReady) {
				const qv = await provider!.embedQuery(parsed.freeText);
				const dense = this.denseRank(qv, allowed);
				dense.forEach((d, i) => {
					const c = get(d.rowid);
					c.score += 1 / (k + i + 1);
					c.semRank = i + 1;
					c.range = d.range;
				});
			}
			if (parsed.sort === 'recent') {
				for (const c of cands.values()) {
					c.score = this.meta.get(c.rowid)!.ts;
				}
			} else {
				const half = this.ranking.recencyHalfLifeDays * DAY;
				for (const c of cands.values()) {
					const age = Math.max(0, now - this.meta.get(c.rowid)!.ts);
					c.score *= 1 + this.ranking.recencyBoost * Math.pow(2, -age / half);
				}
			}
		}

		let ordered = [...cands.values()].sort((a, b) => b.score - a.score || this.meta.get(b.rowid)!.ts - this.meta.get(a.rowid)!.ts);

		// Must-match phrases / excluded terms are verified on the original text (top window only).
		if (parsed.phrases.length > 0 || parsed.excluded.length > 0) {
			const window = ordered.slice(0, Math.max(limit * 20, 500));
			const texts = this.store.getPromptsByRowid(window.map(c => c.rowid));
			const phrases = parsed.phrases.map(p => p.toLowerCase());
			const excluded = parsed.excluded.map(p => p.toLowerCase());
			ordered = window.filter(c => {
				const text = texts.get(c.rowid)?.text.toLowerCase() ?? '';
				return phrases.every(p => text.includes(p)) && !excluded.some(x => text.includes(x));
			});
		}

		// Collapse identical texts (forks, re-pasted prompts) and cap hits per session.
		const collapse = q.collapseDuplicates !== false;
		const byHash = new Map<string, { cand: Candidate; dups: Candidate[] }>();
		const result: { cand: Candidate; dups: Candidate[] }[] = [];
		const perSession = new Map<string, number>();
		const cap = parsed.sort === 'recent' || filters.sessionKey ? Infinity : this.ranking.maxPerSession;
		for (const c of ordered) {
			const m = this.meta.get(c.rowid)!;
			if (collapse) {
				const g = byHash.get(m.hash);
				if (g) {
					g.dups.push(c);
					continue;
				}
			}
			const n = perSession.get(m.sessionKey) ?? 0;
			if (n >= cap) {
				continue;
			}
			perSession.set(m.sessionKey, n + 1);
			const g = { cand: c, dups: [] as Candidate[] };
			byHash.set(m.hash, g);
			if (result.length < limit) {
				result.push(g);
			}
		}

		const hits: SearchHit[] = [];
		const prompts = this.store.getPromptsByRowid(result.map(r => r.cand.rowid));
		for (const { cand, dups } of result) {
			const prompt = prompts.get(cand.rowid);
			if (!prompt) {
				continue;
			}
			const session = this.sessions.get(prompt.sessionKey) ?? { key: prompt.sessionKey, source: 'copilot', sessionId: prompt.sessionKey };
			hits.push({
				prompt,
				session,
				score: cand.score,
				lexicalRank: cand.lexRank,
				semanticRank: cand.semRank,
				matchRange: cand.range && !cand.lexRank ? cand.range : lexicalRange(prompt.text, parsed) ?? cand.range,
				duplicates: dups.map(d => {
					const dm = this.meta.get(d.rowid)!;
					return { promptId: dm.id, sessionKey: dm.sessionKey, timestamp: dm.ts };
				}),
			});
		}

		return {
			query: q.text,
			freeText: parsed.freeText,
			filters,
			mode,
			semanticUnavailable,
			hits,
			tookMs: Math.round(performance.now() - t0),
		};
	}

	private allowedRowids(f: ParsedFilters): Set<number> {
		const origins = new Set<PromptOrigin>(f.origins ?? ['human']);
		const lc = (s: string | undefined) => s?.toLowerCase();
		const repo = lc(f.repo), branch = lc(f.branch), cwd = lc(f.cwd), client = lc(f.client), model = lc(f.model), sess = lc(f.sessionKey);
		const sessionOk = new Map<string, boolean>();
		const out = new Set<number>();
		for (const m of this.meta.values()) {
			if (!origins.has(m.origin) || (m.isAck && !f.includeAcks)) {
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
				const s = this.sessions.get(m.sessionKey);
				ok = !!s
					&& (!f.source || s.source === f.source)
					&& (!repo || !!(lc(s.repository) ?? lc(s.cwd))?.includes(repo))
					&& (!branch || !!lc(s.branch)?.includes(branch))
					&& (!cwd || !!(lc(s.cwd)?.includes(cwd) || lc(s.workspaceUri)?.includes(cwd)))
					&& (!client || !!lc(s.client)?.includes(client))
					&& (!sess || [s.key, s.sessionId, s.agentHostSessionId].some(v => lc(v)?.startsWith(sess) || lc(v) === sess));
				sessionOk.set(m.sessionKey, ok);
			}
			if (ok) {
				out.add(m.rowid);
			}
		}
		return out;
	}

	private denseRank(qv: Float32Array, allowed: Set<number>): { rowid: number; score: number; range: [number, number] }[] {
		const m = this.matrix!;
		const dims = m.dims;
		const best = new Map<number, { max: number; head?: number; range: [number, number] }>();
		for (let i = 0; i < m.count; i++) {
			const rowid = m.promptRowids[i]!;
			if (!allowed.has(rowid)) {
				continue;
			}
			let dot = 0;
			const off = i * dims;
			for (let d = 0; d < dims; d++) {
				dot += m.vectors[off + d]! * qv[d]!;
			}
			let b = best.get(rowid);
			if (!b) {
				b = { max: -Infinity, range: [m.starts[i]!, m.ends[i]!] };
				best.set(rowid, b);
			}
			if (dot > b.max) {
				b.max = dot;
				b.range = [m.starts[i]!, m.ends[i]!];
			}
			if (m.ords[i] === 0) {
				b.head = dot;
			}
		}
		const w = this.ranking.maxChunkWeight;
		const scored = [...best.entries()].map(([rowid, b]) => ({
			rowid,
			score: b.head === undefined ? b.max : w * b.max + (1 - w) * b.head,
			range: b.range,
		}));
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, this.ranking.candidateLimit);
	}
}

function ftsQuote(t: string): string {
	return `"${t.replace(/"/g, '""')}"`;
}

function ftsAnd(q: ParsedQuery): string | undefined {
	const pos = [...q.terms.map(ftsQuote), ...q.phrases.map(ftsQuote)];
	return pos.length ? pos.join(' AND ') : undefined;
}

function ftsOr(q: ParsedQuery): string | undefined {
	if (q.terms.length < 2) {
		return undefined;
	}
	const or = `(${q.terms.map(ftsQuote).join(' OR ')})`;
	return q.phrases.length ? `${q.phrases.map(ftsQuote).join(' AND ')} AND ${or}` : or;
}

function lexicalRange(text: string, q: ParsedQuery): [number, number] | undefined {
	const lower = text.toLowerCase();
	for (const t of [...q.phrases.map(p => p.toLowerCase()), ...q.terms]) {
		const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
		const m = re.exec(lower);
		if (m) {
			return [m.index, m.index + t.length];
		}
	}
	return undefined;
}
