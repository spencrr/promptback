export interface EmbeddingProviderInfo {
	/** Stable identifier that changes whenever vectors become incomparable (model, revision, pooling, prefix...). */
	readonly fingerprint: string;
	readonly displayName: string;
	readonly dims: number;
	/** True when text never leaves this machine. */
	readonly local: boolean;
}

/**
 * Pluggable embedding backend. Vectors must be L2-normalized so cosine similarity is a dot product.
 */
export interface EmbeddingProvider {
	readonly info: EmbeddingProviderInfo;
	embedDocuments: (texts: readonly string[]) => Promise<Float32Array[]>;
	embedQuery: (text: string) => Promise<Float32Array>;
	dispose: () => Promise<void>;
}

export function l2normalize(v: Float32Array): Float32Array {
	let s = 0;
	for (const x of v) {
		s += x * x;
	}
	const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
	for (let i = 0; i < v.length; i++) {
		v[i] = v[i]! * inv;
	}
	return v;
}
