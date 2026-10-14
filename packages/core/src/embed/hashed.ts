import { type EmbeddingProvider, type EmbeddingProviderInfo, l2normalize } from './provider.js';

/**
 * Dependency-free embeddings by the hashing trick: word unigrams and bigrams are hashed into a fixed number of
 * buckets (Weinberger et al., "Feature Hashing for Large Scale Multitask Learning", ICML 2009), sub-linearly
 * weighted and L2-normalised. Cosine similarity then approximates word overlap, so paraphrases score lower than with
 * a neural model, but the whole pipeline (vectors, topics, similarity bars) works on any platform with no model,
 * no download and no native code. Deterministic: the same text always gives the same vector.
 */
export class HashedEmbeddingProvider implements EmbeddingProvider {
	readonly info: EmbeddingProviderInfo;

	constructor(
		private readonly dims = 256,
		private readonly seed = 0x97_47_b2_8c,
	) {
		this.info = {
			fingerprint: `hashed:v1:${dims}:${seed.toString(16)}`,
			displayName: `Hashed words (${dims}d, no model)`,
			dims,
			local: true,
		};
	}

	embed(text: string): Float32Array {
		const v = new Float32Array(this.dims);
		const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
		let previous: string | undefined;
		for (const w of words) {
			this.add(v, w, 1);
			if (previous !== undefined) {
				this.add(v, `${previous} ${w}`, 0.5);
			}
			previous = w;
		}
		// Sub-linear term weighting, as in TF-IDF's log-tf, so repeated words do not dominate.
		for (let i = 0; i < v.length; i++) {
			const x = v[i]!;
			v[i] = x === 0 ? 0 : Math.sign(x) * Math.log1p(Math.abs(x));
		}
		return l2normalize(v);
	}

	/** Two independent hashes: one picks the bucket, the other the sign (which keeps bucket collisions unbiased). */
	private add(v: Float32Array, token: string, weight: number): void {
		const bucket = fnv1a(token, this.seed) % this.dims;
		const sign = fnv1a(token, this.seed + SIGN_SALT) % 2 === 0 ? 1 : -1;
		v[bucket] = v[bucket]! + sign * weight;
	}

	embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
		return Promise.resolve(texts.map(t => this.embed(t)));
	}

	embedQuery(text: string): Promise<Float32Array> {
		return Promise.resolve(this.embed(text));
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}
}

const SIGN_SALT = 0x5b_d1_e9_95;

/** 32-bit FNV-1a over UTF-16 code units, seeded. */
function fnv1a(text: string, seed: number): number {
	// biome-ignore-start lint/suspicious/noBitwiseOperators: hash arithmetic needs 32-bit wraparound.
	let h = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01_00_01_93) >>> 0;
	}
	return h >>> 0;
	// biome-ignore-end lint/suspicious/noBitwiseOperators: hash arithmetic needs 32-bit wraparound.
}
