import { describe, expect, it } from 'vitest';
import { l2normalize } from '../src/embed/provider.js';
import { clusterTopics } from '../src/search/topics.js';

/** Points around three well-separated directions, with small deterministic jitter. */
function blobs(): { vectors: Float32Array[]; texts: string[]; truth: number[] } {
	const centres = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
	const words = [['parser', 'tokenizer', 'grammar'], ['graph', 'layout', 'canvas'], ['pipeline', 'deploy', 'ci']];
	const vectors: Float32Array[] = [], texts: string[] = [], truth: number[] = [];
	let seed = 7;
	const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3;
	centres.forEach((c, k) => {
		for (let i = 0; i < 5; i++) {
			vectors.push(l2normalize(Float32Array.from(c.map(x => x + rnd()))));
			texts.push(`please fix the ${words[k]!.join(' ')} issue number ${i} today`);
			truth.push(k);
		}
	});
	vectors.push(l2normalize(Float32Array.from([0, 0, 0, 1])));
	texts.push('unrelated one-off question');
	truth.push(-1);
	return { vectors, texts, truth };
}

describe('clusterTopics', () => {
	it('recovers well-separated clusters, folds singletons into Other, and labels clusters by distinctive words', () => {
		const { vectors, texts, truth } = blobs();
		const r = clusterTopics(vectors, texts);
		expect(r.topics).toHaveLength(3);
		expect(r.assignment[15]).toBe(-1);
		for (let k = 0; k < 3; k++) {
			const ids = new Set(truth.map((t, i) => (t === k ? r.assignment[i] : undefined)).filter(x => x !== undefined));
			expect(ids.size).toBe(1);
		}
		const labelOf = (i: number) => r.topics.find(t => t.id === r.assignment[i])!.terms;
		expect(labelOf(0)).toEqual(expect.arrayContaining(['parser', 'tokenizer', 'grammar']));
		expect(labelOf(5)).toEqual(expect.arrayContaining(['graph', 'layout', 'canvas']));
		expect(labelOf(0)).not.toContain('issue');
		expect(r.topics.map(t => t.size)).toEqual([5, 5, 5]);
	});

	it('returns no topics for tiny inputs', () => {
		expect(clusterTopics([new Float32Array([1])], ['a'], {}).topics).toEqual([]);
	});
});
