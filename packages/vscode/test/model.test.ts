import { describe, expect, it } from 'vitest';
import type { ExploreResult, ExploreRow } from '@awss/core/types';
import { DEFAULT_VIEW, buildGraph, computeView, highlightTerms, histogram, segments } from '../webview/model.js';

const DAY = 86_400_000;
let n = 0;
function row(over: Partial<ExploreRow>): ExploreRow {
	n++;
	return {
		id: `p${n}`, sessionKey: 's1', preview: `prompt ${n}`, timestamp: Date.UTC(2026, 8, 1) + n * DAY, origin: 'human', length: 10,
		hash: `h${n}`, isAck: false, seq: n, score: 1 / n, matchedLexical: true, matchedSemantic: false, ...over,
	};
}

function result(rows: ExploreRow[], freeText = 'q'): ExploreResult {
	return {
		query: freeText, freeText, mode: 'hybrid', semanticUnavailable: false, revision: '1', tookMs: 1, rows,
		sessions: {
			s1: { key: 's1', source: 'copilot', sessionId: 's1', repository: 'owner/a', client: 'github/cli', title: 'A' },
			s2: { key: 's2', source: 'copilot', sessionId: 's2', repository: 'owner/b', client: 'vscode-agent-host', title: 'B', forkOf: 's1', forkPointSeq: 1 },
			s3: { key: 's3', source: 'vscode-chat', sessionId: 's3', cwd: 'c:\\src\\webapp', client: 'vscode-chat' },
		},
	};
}

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
		const vm = computeView(result(rows), { ...DEFAULT_VIEW, facets: { origin: ['human'], client: [], repo: ['owner/a'] } });
		expect(vm.rows.every(r => r.sessionKey === 's1')).toBe(true);
		expect(Object.fromEntries(vm.facets.repo.map(f => [f.value, f.count]))).toEqual({ 'owner/a': 2, 'owner/b': 1 });
		expect(Object.fromEntries(vm.facets.origin.map(f => [f.value, f.count]))).toEqual({ human: 2 });
	});

	it('falls back to the folder name for sessions without a repository', () => {
		const vm = computeView(result(rows), { ...DEFAULT_VIEW, facets: { origin: [], client: [], repo: [] }, hideAcks: false });
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
			{ text: 'Tree', hit: true }, { text: ' view ', hit: false }, { text: 'design doc', hit: true },
		]);
		expect(segments('Review designs', ['view', 'design']).filter(s => s.hit).map(s => s.text)).toEqual(['design']);
		expect(segments('x', [])).toEqual([{ text: 'x', hit: false }]);
	});

	it('builds graph nodes by relevance with session and fork edges', () => {
		const rs = [
			row({ sessionKey: 's1', seq: 0, similarity: 0.9 }),
			row({ sessionKey: 's1', seq: 3, similarity: 0.7 }),
			row({ sessionKey: 's2', seq: 2, similarity: 0.5 }),
		];
		const res = result(rs);
		const { nodes, edges } = buildGraph(computeView(res, { ...DEFAULT_VIEW, hideDuplicates: false }), res, 10);
		expect(nodes.map(x => x.relevance)).toEqual([1, expect.closeTo(0.575, 3), 0.15]);
		expect(nodes.map(x => x.group)).toEqual(['owner/a', 'owner/a', 'owner/b']);
		expect(edges).toEqual([
			{ from: rs[0]!.id, to: rs[1]!.id, kind: 'session' },
			{ from: rs[1]!.id, to: rs[2]!.id, kind: 'fork' },
		]);
	});
});
