import { describe, expect, it } from 'vitest';
import { HashedEmbeddingProvider } from '../src/embed/hashed.js';
import { createEmbeddingProvider } from '../src/embed/registry.js';

function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		s += a[i]! * b[i]!;
	}
	return s;
}

/** Park–Miller LCG so the statistical checks are reproducible. */
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 16_807) % 2_147_483_647;
		return s / 2_147_483_647;
	};
}

const WORDS =
	'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(
		' ',
	);

describe('hashed embedding provider', () => {
	const p = new HashedEmbeddingProvider();

	it('is deterministic, unit length and independent of word order only through bigrams', async () => {
		const [a, b] = await p.embedDocuments(['fix the flaky retry test', 'fix the flaky retry test']);
		expect(a).toEqual(b);
		expect(Math.hypot(...a!)).toBeCloseTo(1, 5);
		expect(p.info).toMatchObject({ dims: 256, local: true, fingerprint: expect.stringMatching(/^hashed:v1:256:/) });
		const shuffled = await p.embedQuery('test retry flaky the fix');
		const similarity = dot(a!, shuffled);
		expect(similarity).toBeGreaterThan(0.6);
		expect(similarity).toBeLessThan(1);
	});

	it('ranks texts sharing words above unrelated texts, with margin, over seeded random documents', async () => {
		const next = rng(42);
		const pick = (n: number) =>
			Array.from({ length: n }, () => WORDS[Math.floor(next() * WORDS.length)]!).join(' ');
		let related = 0;
		let unrelated = 0;
		const trials = 200;
		for (let t = 0; t < trials; t++) {
			const base = pick(8);
			// A paraphrase keeps most words and swaps two; an unrelated text shares none on purpose.
			const words = base.split(' ');
			words[1] = 'extra';
			words[6] = 'words';
			const paraphrase = words.join(' ');
			const other = Array.from({ length: 8 }, () => `x${Math.floor(next() * 1000)}`).join(' ');
			const [b, q, o] = await p.embedDocuments([base, paraphrase, other]);
			related += dot(b!, q!);
			unrelated += dot(b!, o!);
		}
		related /= trials;
		unrelated /= trials;
		// Collisions between unrelated hashed words are rare in 256 buckets: their mean similarity stays near 0.
		expect(unrelated).toBeLessThan(0.1);
		expect(unrelated).toBeGreaterThan(-0.1);
		expect(related).toBeGreaterThan(unrelated + 0.4);
	});

	it('is a registered provider with validated options', async () => {
		const small = await createEmbeddingProvider(
			{ kind: 'hashed', dims: 64 },
			{ cacheDir: 'unused', allowDownload: false },
		);
		expect(small?.info.dims).toBe(64);
		await expect(
			createEmbeddingProvider({ kind: 'hashed', dims: 7 }, { cacheDir: 'unused', allowDownload: false }),
		).rejects.toThrow(/dims/);
		const empty = await p.embedQuery('');
		expect(Array.from(empty).every(x => x === 0)).toBe(true);
	});
});
