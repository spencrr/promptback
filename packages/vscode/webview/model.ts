/**
 * Pure client-side data logic for the Explorer: filtering, facet counts, sorting, grouping, duplicate hiding, the date
 * histogram, colours and the graph model. The host returns every matching occurrence once per query; everything here
 * is instant and local, and unit-tested.
 */
import type {
	ClientInfo,
	ExploreResult,
	ExploreRow,
	PromptOrigin,
	SessionInfo,
	SourceCatalog,
} from '@promptback/core/types';
import type { GraphEdge, GraphNode } from './graph.js';

export type FacetKey = 'origin' | 'client' | 'repo';
export type SortKey = 'relevance' | 'time' | 'length' | 'repo' | 'session';
export type GroupBy = 'none' | 'day' | 'session' | 'repo' | 'topic';
export type ColorBy = 'topic' | 'repo' | 'source' | 'session';

export interface ViewState {
	readonly facets: Readonly<Record<FacetKey, readonly string[]>>;
	readonly dateRange?: readonly [from: number, to: number];
	readonly hideAcks: boolean;
	readonly hideDuplicates: boolean;
	readonly sort: SortKey;
	readonly sortDesc: boolean;
	readonly groupBy: GroupBy;
	readonly colorBy: ColorBy;
}

export const DEFAULT_VIEW: ViewState = {
	facets: { origin: ['human'], client: [], repo: [] },
	hideAcks: true,
	hideDuplicates: true,
	sort: 'relevance',
	sortDesc: true,
	groupBy: 'none',
	colorBy: 'topic',
};

export const NO_FOLDER = 'No folder';

/** Clients (where a prompt was sent) as declared by the source plugins; the host sends the catalog with `init`. */
let clients: Readonly<Record<string, ClientInfo>> = {};

export function setClientCatalog(catalog: SourceCatalog): void {
	clients = catalog.clients;
}

export function clientInfo(id: string | undefined): ClientInfo {
	return (
		(id && clients[id]) || {
			id: id ?? 'unknown',
			label: id ?? 'Unknown',
			icon: 'history',
			color: 'foreground',
			aliases: [],
		}
	);
}

export function clientLabel(id: string | undefined): string {
	return clientInfo(id).label;
}

export const ORIGIN_LABELS: Record<PromptOrigin, string> = {
	human: 'You',
	agent: 'Agent',
	skill: 'Skill',
	system: 'System',
	autopilot: 'Autopilot',
};

/** Okabe–Ito: a colour-blind-safe categorical palette (Okabe & Ito, "Color Universal Design", 2008). */
export const PALETTE = ['#56B4E9', '#E69F00', '#009E73', '#CC79A7', '#0072B2', '#D55E00', '#F0E442'];
export const OTHER_COLOR = '#8c8c8c';

export type RepoKind = 'repo' | 'inferred' | 'folder' | 'none';

/** What to show for a session's location: a repository (`owner/name`), an inferred one, a plain folder, or none. */
export function repoInfo(s: SessionInfo | undefined): { label: string; kind: RepoKind } {
	if (s?.repository) {
		return { label: s.repository, kind: s.repositoryInferred ? 'inferred' : 'repo' };
	}
	if (s?.cwd && !s.workspaceless) {
		return { label: s.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? NO_FOLDER, kind: 'folder' };
	}
	return { label: NO_FOLDER, kind: 'none' };
}

export function repoLabel(s: SessionInfo | undefined): string {
	return repoInfo(s).label;
}

export function facetValue(key: FacetKey, row: ExploreRow, session: SessionInfo | undefined): string {
	switch (key) {
		case 'origin':
			return row.origin;
		case 'client':
			return session?.client ?? 'unknown';
		case 'repo':
			return repoLabel(session);
	}
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
		if (key !== skip && sel.length > 0 && !sel.includes(facetValue(key, row, s))) {
			return false;
		}
	}
	return true;
}

export interface FacetCount {
	readonly value: string;
	readonly count: number;
}

/** A row of the table: a prompt, or a group header when grouping is on. */
export type DisplayItem =
	| { readonly kind: 'row'; readonly row: ExploreRow }
	| {
			readonly kind: 'group';
			readonly key: string;
			readonly label: string;
			readonly count: number;
			readonly color?: string;
	  };

export interface ViewModel {
	/** Visible rows in display order. */
	readonly rows: readonly ExploreRow[];
	/** Rows interleaved with group headers (same as `rows` when not grouping). */
	readonly items: readonly DisplayItem[];
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
		facets[key] = [...counts]
			.map(([value, count]) => ({ value, count }))
			.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
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
		rows = rows.filter(r => !seen.has(r.hash) && Boolean(seen.add(r.hash)));
	}
	const { rows: ordered, items } = group(rows, result, v.groupBy);
	return { rows: ordered, items, dupCounts, facets, timeline, totalMatches: result.rows.length };
}

function sortRows(rows: ExploreRow[], result: ExploreResult, v: ViewState): ExploreRow[] {
	const dir = v.sortDesc ? -1 : 1;
	const browse = !result.freeText;
	const cmp: Record<SortKey, (a: ExploreRow, b: ExploreRow) => number> = {
		// The host already returns relevance order (newest first for browse queries).
		relevance: () => 0,
		time: (a, b) => a.timestamp - b.timestamp,
		length: (a, b) => a.length - b.length,
		repo: (a, b) =>
			repoLabel(result.sessions[a.sessionKey]).localeCompare(repoLabel(result.sessions[b.sessionKey])) ||
			b.timestamp - a.timestamp,
		session: (a, b) =>
			(result.sessions[a.sessionKey]?.title ?? '').localeCompare(result.sessions[b.sessionKey]?.title ?? '') ||
			a.seq - b.seq,
	};
	if (v.sort === 'relevance') {
		return v.sortDesc || browse ? rows : [...rows].reverse();
	}
	return [...rows].sort((a, b) => dir * cmp[v.sort](a, b));
}

/** Groups keep the current sort inside them; groups are ordered by their best (first) row. */
function group(
	rows: readonly ExploreRow[],
	result: ExploreResult,
	by: GroupBy,
): { rows: ExploreRow[]; items: DisplayItem[] } {
	if (by === 'none') {
		return { rows: [...rows], items: rows.map(row => ({ kind: 'row', row })) };
	}
	const groups = new Map<string, { label: string; color?: string; rows: ExploreRow[] }>();
	const colors = topicColors(result);
	for (const row of rows) {
		const [key, label, color] = groupKey(row, result, by, colors);
		(groups.get(key) ?? groups.set(key, { label, color, rows: [] }).get(key)!).rows.push(row);
	}
	const out: DisplayItem[] = [];
	const ordered: ExploreRow[] = [];
	for (const [key, g] of groups) {
		out.push({ kind: 'group', key, label: g.label, count: g.rows.length, color: g.color });
		for (const row of g.rows) {
			out.push({ kind: 'row', row });
			ordered.push(row);
		}
	}
	return { rows: ordered, items: out };
}

function groupKey(
	row: ExploreRow,
	result: ExploreResult,
	by: GroupBy,
	topicColor: ReadonlyMap<number, string>,
): [string, string, string?] {
	const s = result.sessions[row.sessionKey];
	switch (by) {
		case 'day': {
			const label = dayLabel(row.timestamp);
			return [label, label];
		}
		case 'session':
			return [row.sessionKey, s?.title ?? 'Untitled session'];
		case 'repo': {
			const label = repoLabel(s);
			return [label, label];
		}
		case 'topic': {
			const t = result.topics.find(x => x.id === row.topic);
			return t
				? [`t${t.id}`, t.label, topicColor.get(t.id)]
				: ['other', row.topic === -1 ? 'Other topics' : 'Not clustered', OTHER_COLOR];
		}
		default:
			return ['', ''];
	}
}

/** "Today", "Yesterday", weekday names for the last week, then "Mar 3, 2026". */
export function dayLabel(ts: number, now = Date.now()): string {
	const start = (t: number) => {
		const d = new Date(t);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	};
	const days = Math.round((start(now) - start(ts)) / 86_400_000);
	if (days <= 0) {
		return 'Today';
	}
	if (days === 1) {
		return 'Yesterday';
	}
	if (days < 7) {
		return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
	}
	return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function topicColors(result: ExploreResult): Map<number, string> {
	return new Map(result.topics.map((t, i) => [t.id, PALETTE[i % PALETTE.length]!]));
}

/** Stable colour assignment for categorical values: most frequent first; beyond the palette everything is "Other". */
export function categoryColors(values: readonly string[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const v of values) {
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
	return new Map(ordered.map((v, i) => [v, i < PALETTE.length ? PALETTE[i]! : OTHER_COLOR]));
}

export interface Bucket {
	readonly start: number;
	readonly end: number;
	readonly count: number;
}

/** Day/week/month buckets depending on the span, newest last. */
export function histogram(timestamps: readonly number[], maxBuckets = 60): Bucket[] {
	if (timestamps.length === 0) {
		return [];
	}
	const min = Math.min(...timestamps);
	const max = Math.max(...timestamps);
	const Day = 86_400_000;
	const span = Math.max(Day, max - min);
	const size = [Day, 7 * Day, 30 * Day, 91 * Day, 365 * Day].find(s => span / s <= maxBuckets) ?? 365 * Day;
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

const STOPWORDS = new Set(
	(
		'the and for are was were with that this from have has had not but you your our can could would should will ' +
		'what when where which who why how about into then than them they their there these those also any some all just like want need ' +
		'please make use using get let lets its'
	).split(' '),
);

/** Lowercased words to highlight (query words and quoted phrases; operators and stopwords dropped). */
export function highlightTerms(freeText: string): string[] {
	const quoted = [...freeText.matchAll(/"([^"]+)"/g)].map(m => m[1]!.toLowerCase());
	const words = (
		freeText
			.replace(/"[^"]*"/g, ' ')
			.toLowerCase()
			.match(/[\p{L}\p{N}_]{3,}/gu) ?? []
	).filter(w => !STOPWORDS.has(w));
	return [...new Set([...quoted, ...words])];
}

/** Splits text into plain/highlighted segments. Matches start at word boundaries ("design" hits "designs", not "redesign"). */
export function segments(text: string, terms: readonly string[]): { text: string; hit: boolean }[] {
	if (terms.length === 0 || !text) {
		return [{ text, hit: false }];
	}
	const re = new RegExp(
		`(?<![\\p{L}\\p{N}_])(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
		'giu',
	);
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
	const steps: [number, string][] = [
		[31_536_000, 'y'],
		[2_592_000, 'mo'],
		[86_400, 'd'],
		[3600, 'h'],
		[60, 'm'],
	];
	for (const [sec, unit] of steps) {
		if (s >= sec) {
			return `${Math.floor(s / sec)}${unit} ago`;
		}
	}
	return 'just now';
}

export interface GraphModel {
	readonly nodes: GraphNode[];
	readonly edges: GraphEdge[];
	/** Groups in angular order, with colours, for the legend and rim labels. */
	readonly groups: { readonly key: string; readonly label: string; readonly color: string; readonly count: number }[];
}

/**
 * The top visible rows as a radial graph:
 * - distance from the centre = 1 − relevance (min–max normalized similarity, else rank; recency when browsing);
 * - a slice of the circle per group (topic, repository, source or session) — the colour;
 * - inside a slice, angle = time (older → newer clockwise), so position carries no fake meaning;
 * - edges join consecutive prompts of one session, and a fork's first prompt to its parent session (dashed).
 */
export function buildGraph(vm: ViewModel, result: ExploreResult, limit: number, colorBy: ColorBy): GraphModel {
	const rows = vm.rows.slice(0, limit);
	const sims = rows.map(r => r.similarity).filter((x): x is number => x !== undefined);
	const lo = Math.min(...sims);
	const hi = Math.max(...sims);
	const topicColor = topicColors(result);
	const keyOf = (r: ExploreRow): [string, string] => {
		const s = result.sessions[r.sessionKey];
		switch (colorBy) {
			case 'topic': {
				const t = result.topics.find(x => x.id === r.topic);
				return t ? [`t${t.id}`, t.label] : ['other', r.topic === -1 ? 'Other topics' : 'Not clustered'];
			}
			case 'repo':
				return [repoLabel(s), repoLabel(s)];
			case 'source':
				return [s?.client ?? 'unknown', clientLabel(s?.client)];
			case 'session':
				return [r.sessionKey, s?.title ?? 'Untitled session'];
		}
	};
	const keys = rows.map(keyOf);
	const colors =
		colorBy === 'topic'
			? new Map(result.topics.map(t => [`t${t.id}`, topicColor.get(t.id)!]))
			: categoryColors(keys.map(([k]) => k));
	const colorFor = (k: string) => colors.get(k) ?? OTHER_COLOR;
	// Categories beyond the palette share one grey "Other" slice.
	const effective = keys.map(([k, label]): [string, string] =>
		colorBy !== 'topic' && colorFor(k) === OTHER_COLOR ? ['other', 'Other'] : [k, label],
	);

	const times = rows.map(r => r.timestamp);
	const t0 = Math.min(...times);
	const t1 = Math.max(...times);
	const nodes: GraphNode[] = rows.map((r, i) => {
		let relevance: number;
		if (!result.freeText) {
			relevance = 1 - i / Math.max(1, rows.length - 1);
		} else if (r.similarity !== undefined && hi > lo) {
			relevance = 0.15 + 0.85 * ((r.similarity - lo) / (hi - lo));
		} else {
			relevance = 1 - i / Math.max(1, rows.length);
		}
		const [slice] = effective[i]!;
		return {
			id: r.id,
			label: r.preview.trim().split(/\r?\n/, 1)[0] ?? '',
			group: slice,
			color: slice === 'other' ? OTHER_COLOR : colorFor(slice),
			sessionKey: r.sessionKey,
			seq: r.seq,
			relevance: Math.max(0, Math.min(1, relevance)),
			order: t1 > t0 ? (r.timestamp - t0) / (t1 - t0) : 0.5,
			rank: i,
		};
	});

	const groupStats = new Map<string, { label: string; color: string; count: number; best: number }>();
	for (const [i, [key, label]] of effective.entries()) {
		const g = groupStats.get(key) ?? { label, color: nodes[i]!.color, count: 0, best: i };
		g.count++;
		groupStats.set(key, g);
	}
	const groups = [...groupStats]
		.sort((a, b) => a[1].best - b[1].best)
		.map(([key, g]) => ({ key, label: g.label, color: g.color, count: g.count }));

	const bySession = new Map<string, GraphNode[]>();
	for (const n of nodes) {
		let list = bySession.get(n.sessionKey);
		if (!list) {
			list = [];
			bySession.set(n.sessionKey, list);
		}
		list.push(n);
	}
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
			edges.push({ from: parent.at(-1)!.id, to: list[0]!.id, kind: 'fork' });
		}
	}
	return { nodes, edges, groups };
}
