/**
 * Pure client-side data logic for the Explorer: filtering, facet counts, sorting, duplicate hiding and the date
 * histogram. The host returns every matching occurrence once per query; everything here is instant and local.
 */
import type { ExploreResult, ExploreRow, PromptOrigin, SessionInfo } from '@awss/core/types';
import type { GraphEdge, GraphNode } from './graph.js';

export type FacetKey = 'origin' | 'client' | 'repo';
export type SortKey = 'relevance' | 'time' | 'length' | 'repo' | 'session';

export interface ViewState {
	readonly facets: Readonly<Record<FacetKey, readonly string[]>>;
	readonly dateRange?: readonly [from: number, to: number];
	readonly hideAcks: boolean;
	readonly hideDuplicates: boolean;
	readonly sort: SortKey;
	readonly sortDesc: boolean;
}

export const DEFAULT_VIEW: ViewState = {
	facets: { origin: ['human'], client: [], repo: [] },
	hideAcks: true,
	hideDuplicates: true,
	sort: 'relevance',
	sortDesc: true,
};

export const NO_REPO = '(no repository)';

export const CLIENT_LABELS: Record<string, string> = {
	'vscode-agent-host': 'Agents window',
	'github/cli': 'Copilot CLI',
	'github/autopilot': 'Autopilot',
	'vscode-chat': 'Chat panel',
};

export const ORIGIN_LABELS: Record<PromptOrigin, string> = {
	human: 'You',
	agent: 'Agent',
	skill: 'Skill',
	system: 'System',
	autopilot: 'Autopilot',
};

export function facetValue(key: FacetKey, row: ExploreRow, session: SessionInfo | undefined): string {
	switch (key) {
		case 'origin': return row.origin;
		case 'client': return session?.client ?? 'unknown';
		case 'repo': return repoLabel(session);
	}
}

export function repoLabel(s: SessionInfo | undefined): string {
	if (s?.repository) {
		return s.repository;
	}
	if (s?.cwd) {
		const parts = s.cwd.split(/[\\/]/).filter(Boolean);
		return parts.slice(-1)[0] ?? NO_REPO;
	}
	return NO_REPO;
}

function passes(row: ExploreRow, s: SessionInfo | undefined, v: ViewState, skip?: FacetKey | 'date'): boolean {
	if (v.hideAcks && row.isAck) {
		return false;
	}
	if (skip !== 'date' && v.dateRange && (row.timestamp < v.dateRange[0] || row.timestamp >= v.dateRange[1])) {
		return false;
	}
	for (const key of ['origin', 'client', 'repo'] as const) {
		const sel = v.facets[key];
		if (key !== skip && sel.length && !sel.includes(facetValue(key, row, s))) {
			return false;
		}
	}
	return true;
}

export interface FacetCount {
	readonly value: string;
	readonly count: number;
}

export interface ViewModel {
	/** Visible rows in display order. */
	readonly rows: readonly ExploreRow[];
	/** Occurrences per text hash among the filtered rows (for the ×N badge). */
	readonly dupCounts: ReadonlyMap<string, number>;
	/** Counts per facet value, computed with every filter except that facet's own (so options never vanish). */
	readonly facets: Readonly<Record<FacetKey, readonly FacetCount[]>>;
	/** Rows passing all filters except the date range, for the histogram. */
	readonly timeline: readonly number[];
	readonly totalMatches: number;
}

export function computeView(result: ExploreResult, v: ViewState): ViewModel {
	const sess = (r: ExploreRow) => result.sessions[r.sessionKey];

	const facets = {} as Record<FacetKey, FacetCount[]>;
	for (const key of ['origin', 'client', 'repo'] as const) {
		const counts = new Map<string, number>();
		for (const r of result.rows) {
			if (passes(r, sess(r), v, key)) {
				const val = facetValue(key, r, sess(r));
				counts.set(val, (counts.get(val) ?? 0) + 1);
			}
		}
		for (const sel of v.facets[key]) {
			if (!counts.has(sel)) {
				counts.set(sel, 0);
			}
		}
		facets[key] = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
	}

	const timeline = result.rows.filter(r => passes(r, sess(r), v, 'date')).map(r => r.timestamp);
	let rows = result.rows.filter(r => passes(r, sess(r), v));
	const dupCounts = new Map<string, number>();
	for (const r of rows) {
		dupCounts.set(r.hash, (dupCounts.get(r.hash) ?? 0) + 1);
	}

	rows = sortRows(rows, result, v);
	if (v.hideDuplicates) {
		const seen = new Set<string>();
		rows = rows.filter(r => !seen.has(r.hash) && !!seen.add(r.hash));
	}
	return { rows, dupCounts, facets, timeline, totalMatches: result.rows.length };
}

function sortRows(rows: ExploreRow[], result: ExploreResult, v: ViewState): ExploreRow[] {
	const dir = v.sortDesc ? -1 : 1;
	const browse = !result.freeText;
	const cmp: Record<SortKey, (a: ExploreRow, b: ExploreRow) => number> = {
		// The host already returns relevance order (newest first for browse queries).
		relevance: () => 0,
		time: (a, b) => a.timestamp - b.timestamp,
		length: (a, b) => a.length - b.length,
		repo: (a, b) => repoLabel(result.sessions[a.sessionKey]).localeCompare(repoLabel(result.sessions[b.sessionKey])) || b.timestamp - a.timestamp,
		session: (a, b) => (result.sessions[a.sessionKey]?.title ?? '').localeCompare(result.sessions[b.sessionKey]?.title ?? '') || a.seq - b.seq,
	};
	if (v.sort === 'relevance') {
		return v.sortDesc || browse ? rows : [...rows].reverse();
	}
	return [...rows].sort((a, b) => dir * cmp[v.sort](a, b));
}

export interface Bucket {
	readonly start: number;
	readonly end: number;
	readonly count: number;
}

/** Day/week/month buckets depending on the span, newest last. */
export function histogram(timestamps: readonly number[], maxBuckets = 60): Bucket[] {
	if (!timestamps.length) {
		return [];
	}
	const min = Math.min(...timestamps), max = Math.max(...timestamps);
	const DAY = 86_400_000;
	const span = Math.max(DAY, max - min);
	const size = [DAY, 7 * DAY, 30 * DAY, 91 * DAY, 365 * DAY].find(s => span / s <= maxBuckets) ?? 365 * DAY;
	const start = startOfDay(min);
	const n = Math.floor((max - start) / size) + 1;
	const counts = new Array<number>(n).fill(0);
	for (const t of timestamps) {
		counts[Math.min(n - 1, Math.floor((t - start) / size))]!++;
	}
	return counts.map((count, i) => ({ start: start + i * size, end: start + (i + 1) * size, count }));
}

function startOfDay(t: number): number {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const STOPWORDS = new Set(('the and for are was were with that this from have has had not but you your our can could would should will '
	+ 'what when where which who why how about into then than them they their there these those also any some all just like want need '
	+ 'please make use using get let lets its').split(' '));

/** Lowercased words to highlight (query words and quoted phrases; operators and stopwords dropped). */
export function highlightTerms(freeText: string): string[] {
	const quoted = [...freeText.matchAll(/"([^"]+)"/g)].map(m => m[1]!.toLowerCase());
	const words = (freeText.replace(/"[^"]*"/g, ' ').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter(w => !STOPWORDS.has(w));
	return [...new Set([...quoted, ...words])];
}

/** Splits text into plain/highlighted segments. Matches start at word boundaries ("design" hits "designs", not "redesign"). */
export function segments(text: string, terms: readonly string[]): { text: string; hit: boolean }[] {
	if (!terms.length || !text) {
		return [{ text, hit: false }];
	}
	const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
	const out: { text: string; hit: boolean }[] = [];
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index! > last) {
			out.push({ text: text.slice(last, m.index), hit: false });
		}
		out.push({ text: m[0], hit: true });
		last = m.index! + m[0].length;
	}
	if (last < text.length) {
		out.push({ text: text.slice(last), hit: false });
	}
	return out;
}

export function relativeTime(ts: number, now = Date.now()): string {
	const s = Math.max(0, (now - ts) / 1000);
	if (s < 60) {
		return 'just now';
	}
	const steps: [number, string][] = [[31_536_000, 'y'], [2_592_000, 'mo'], [86_400, 'd'], [3_600, 'h'], [60, 'm']];
	for (const [sec, unit] of steps) {
		if (s >= sec) {
			return `${Math.floor(s / sec)}${unit} ago`;
		}
	}
	return 'just now';
}

/** Top-N visible rows as graph nodes, plus session-sequence and fork edges between them. */
export function buildGraph(vm: ViewModel, result: ExploreResult, limit: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const rows = vm.rows.slice(0, limit);
	const sims = rows.map(r => r.similarity).filter((x): x is number => x !== undefined);
	const lo = Math.min(...sims), hi = Math.max(...sims);
	const nodes: GraphNode[] = rows.map((r, i) => {
		let relevance: number;
		if (!result.freeText) {
			relevance = 1 - i / Math.max(1, rows.length - 1);
		} else if (r.similarity !== undefined && hi > lo) {
			relevance = 0.15 + 0.85 * ((r.similarity - lo) / (hi - lo));
		} else {
			relevance = 1 - i / Math.max(1, rows.length);
		}
		return {
			id: r.id,
			label: r.preview.trim().split(/\r?\n/, 1)[0] ?? '',
			group: repoLabel(result.sessions[r.sessionKey]),
			sessionKey: r.sessionKey,
			seq: r.seq,
			relevance: Math.max(0, Math.min(1, relevance)),
			rank: i,
		};
	});
	const bySession = new Map<string, GraphNode[]>();
	nodes.forEach(n => (bySession.get(n.sessionKey) ?? bySession.set(n.sessionKey, []).get(n.sessionKey)!).push(n));
	const edges: GraphEdge[] = [];
	for (const list of bySession.values()) {
		list.sort((a, b) => a.seq - b.seq);
		for (let i = 1; i < list.length; i++) {
			edges.push({ from: list[i - 1]!.id, to: list[i]!.id, kind: 'session' });
		}
	}
	for (const [key, list] of bySession) {
		const parentKey = result.sessions[key]?.forkOf;
		const parent = parentKey ? bySession.get(parentKey) : undefined;
		if (parent?.length) {
			edges.push({ from: parent[parent.length - 1]!.id, to: list[0]!.id, kind: 'fork' });
		}
	}
	return { nodes, edges };
}
