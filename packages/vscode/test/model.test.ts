import type { ExploreResult, ExploreRow, Topic } from '@promptback/core/types';
import { describe, expect, it } from 'vitest';
import {
	buildGraph,
	categoryColors,
	computeView,
	DEFAULT_VIEW,
	dayLabel,
	highlightTerms,
	histogram,
	OTHER_COLOR,
	PALETTE,
	repoInfo,
	segments,
} from '../webview/model.js';

const DAY = 86_400_000;
let n = 0;
function row(over: Partial<ExploreRow>): ExploreRow {
	n++;
	return {
		id: `p${n}`,
		sessionKey: 's1',
		preview: `prompt ${n}`,
		timestamp: Date.UTC(2026, 8, 1) + n * DAY,
		origin: 'human',
		length: 10,
		hash: `h${n}`,
		isAck: false,
		seq: n,
		score: 1 / n,
		matchedLexical: true,
		matchedSemantic: false,
		...over,
	};
}

function result(rows: ExploreRow[], freeText = 'q', topics: Topic[] = []): ExploreResult {
	return {
		query: freeText,
		freeText,
		mode: 'hybrid',
		semanticUnavailable: false,
		semantic: { state: 'ready' },
		revision: '1',
		tookMs: 1,
		rows,
		topics,
		sessions: {
			s1: {
				key: 's1',
				source: 'copilot',
				sessionId: 's1',
				repository: 'owner/a',
				client: 'github/cli',
				title: 'A',
			},
			s2: {
				key: 's2',
				source: 'copilot',
				sessionId: 's2',
				repository: 'owner/b',
				client: 'vscode-agent-host',
				title: 'B',
				forkOf: 's1',
				forkPointSeq: 1,
			},
			s3: { key: 's3', source: 'vscode-chat', sessionId: 's3', cwd: 'c:\\src\\webapp', client: 'vscode-chat' },
			s4: {
				key: 's4',
				source: 'copilot',
				sessionId: 's4',
				cwd: 'c:\\Users\\me\\.copilot\\chats\\abc',
				workspaceless: true,
				client: 'vscode-agent-host',
			},
			s5: {
				key: 's5',
				source: 'copilot',
				sessionId: 's5',
				repository: 'owner/c',
				repositoryInferred: true,
				workspaceless: true,
			},
		},
	};
}

describe('repoInfo', () => {
	it('distinguishes repositories, inferred repositories, folders and no folder (never a GUID)', () => {
		const r = result([]);
		expect(repoInfo(r.sessions.s1)).toEqual({ label: 'owner/a', kind: 'repo' });
		expect(repoInfo(r.sessions.s3)).toEqual({ label: 'webapp', kind: 'folder' });
		expect(repoInfo(r.sessions.s4)).toEqual({ label: 'No folder', kind: 'none' });
		expect(repoInfo(r.sessions.s5)).toEqual({ label: 'owner/c', kind: 'inferred' });
	});
});

describe('grouping', () => {
	it('inserts group headers that keep the sort order inside each group', () => {
		const rows = [row({ sessionKey: 's1' }), row({ sessionKey: 's2' }), row({ sessionKey: 's1' })];
		const vm = computeView(result(rows), { ...DEFAULT_VIEW, groupBy: 'repo' });
		expect(vm.items.map(i => (i.kind === 'group' ? `[${i.label} ${i.count}]` : i.row.id))).toEqual([
			'[owner/a 2]',
			rows[0]!.id,
			rows[2]!.id,
			'[owner/b 1]',
			rows[1]!.id,
		]);
		expect(vm.rows.map(r => r.id)).toEqual([rows[0]!.id, rows[2]!.id, rows[1]!.id]);
	});

	it('groups by topic with the topic colours', () => {
		const topics: Topic[] = [{ id: 0, label: 'Graph work', terms: [], size: 1 }];
		const rows = [row({ topic: 0 }), row({ topic: -1 })];
		const vm = computeView(result(rows, 'q', topics), { ...DEFAULT_VIEW, groupBy: 'topic' });
		const groups = vm.items.filter(i => i.kind === 'group');
		expect(groups.map(g => g.kind === 'group' && [g.label, g.color])).toEqual([
			['Graph work', PALETTE[0]],
			['Other topics', OTHER_COLOR],
		]);
	});

	it('labels days relative to today', () => {
		const now = new Date(2026, 9, 6, 12).getTime();
		expect(dayLabel(now - 3_600_000, now)).toBe('Today');
		expect(dayLabel(now - DAY, now)).toBe('Yesterday');
		expect(dayLabel(now - 30 * DAY, now)).toMatch(/2026/u);
	});

	it('assigns palette colours by frequency and greys out the rest', () => {
		const values = ['a', 'a', 'b', ...'cdefghij'.split('')];
		const c = categoryColors(values);
		expect(c.get('a')).toBe(PALETTE[0]);
		expect([...c.values()].filter(x => x === OTHER_COLOR)).toHaveLength(10 - PALETTE.length);
	});
});

describe('computeView', () => {
	const rows = [
		row({ sessionKey: 's1' }),
		row({ sessionKey: 's2', hash: 'same' }),
		row({ sessionKey: 's1', hash: 'same' }),
		row({ sessionKey: 's3', origin: 'agent' }),
		row({ sessionKey: 's3', isAck: true, preview: 'continue' }),
	];

	it('defaults to your prompts, hides acks and duplicate texts, keeps relevance order', () => {
		const vm = computeView(result(rows), DEFAULT_VIEW);
		expect(vm.rows.map(r => r.id)).toEqual([rows[0]!.id, rows[1]!.id]);
		expect(vm.dupCounts.get('same')).toBe(2);
		expect(vm.totalMatches).toBe(5);
	});

	it('counts each facet with every other filter applied, so selected options never hide their siblings', () => {
		const vm = computeView(result(rows), {
			...DEFAULT_VIEW,
			facets: { origin: ['human'], client: [], repo: ['owner/a'] },
		});
		expect(vm.rows.every(r => r.sessionKey === 's1')).toBe(true);
		expect(Object.fromEntries(vm.facets.repo.map(f => [f.value, f.count]))).toEqual({ 'owner/a': 2, 'owner/b': 1 });
		expect(Object.fromEntries(vm.facets.origin.map(f => [f.value, f.count]))).toEqual({ human: 2 });
	});

	it('falls back to the folder name for sessions without a repository', () => {
		const vm = computeView(result(rows), {
			...DEFAULT_VIEW,
			facets: { origin: [], client: [], repo: [] },
			hideAcks: false,
		});
		expect(vm.facets.repo.map(f => f.value)).toContain('webapp');
	});

	it('sorts by time and applies a date range', () => {
		const v = { ...DEFAULT_VIEW, hideDuplicates: false, sort: 'time' as const, sortDesc: false };
		const vm = computeView(result(rows), v);
		expect(vm.rows.map(r => r.timestamp)).toEqual([...vm.rows.map(r => r.timestamp)].sort((a, b) => a - b));
		const ranged = computeView(result(rows), { ...v, dateRange: [rows[1]!.timestamp, rows[2]!.timestamp + 1] });
		expect(ranged.rows.map(r => r.id)).toEqual([rows[1]!.id, rows[2]!.id]);
		expect(ranged.timeline).toHaveLength(3);
	});
});

describe('helpers', () => {
	it('buckets timestamps adaptively', () => {
		const t0 = Date.UTC(2026, 0, 1);
		expect(histogram([t0, t0 + 2 * DAY, t0 + 2 * DAY]).map(b => b.count)).toEqual([1, 0, 2]);
		expect(histogram(Array.from({ length: 400 }, (_, i) => t0 + i * DAY)).length).toBeLessThanOrEqual(60);
		expect(histogram([])).toEqual([]);
	});

	it('extracts highlight terms and splits text into segments', () => {
		expect(highlightTerms('tree "design doc" for a of')).toEqual(['design doc', 'tree']);
		expect(segments('Tree view design doc', ['tree', 'design doc'])).toEqual([
			{ text: 'Tree', hit: true },
			{ text: ' view ', hit: false },
			{ text: 'design doc', hit: true },
		]);
		expect(
			segments('Review designs', ['view', 'design'])
				.filter(s => s.hit)
				.map(s => s.text),
		).toEqual(['design']);
		expect(segments('x', [])).toEqual([{ text: 'x', hit: false }]);
	});

	it('builds graph nodes by relevance with session and fork edges, coloured by the chosen grouping', () => {
		const rs = [
			row({ sessionKey: 's1', seq: 0, similarity: 0.9, topic: 0 }),
			row({ sessionKey: 's1', seq: 3, similarity: 0.7, topic: 0 }),
			row({ sessionKey: 's2', seq: 2, similarity: 0.5, topic: -1 }),
		];
		const res = result(rs, 'q', [{ id: 0, label: 'Graph work', terms: [], size: 2 }]);
		const vm = computeView(res, { ...DEFAULT_VIEW, hideDuplicates: false });
		const byRepo = buildGraph(vm, res, 10, 'repo');
		expect(byRepo.nodes.map(x => x.relevance)).toEqual([1, expect.closeTo(0.575, 3), 0.15]);
		expect(byRepo.nodes.map(x => x.group)).toEqual(['owner/a', 'owner/a', 'owner/b']);
		expect(byRepo.nodes.map(x => x.order)).toEqual([0, 0.5, 1]);
		expect(byRepo.edges).toEqual([
			{ from: rs[0]!.id, to: rs[1]!.id, kind: 'session' },
			{ from: rs[1]!.id, to: rs[2]!.id, kind: 'fork' },
		]);
		const byTopic = buildGraph(vm, res, 10, 'topic');
		expect(byTopic.groups.map(g => [g.label, g.color, g.count])).toEqual([
			['Graph work', PALETTE[0], 2],
			['Other topics', OTHER_COLOR, 1],
		]);
	});
});
