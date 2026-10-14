import * as fs from 'node:fs';
import * as path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-node';
import type { LocalModelSpec } from './models.js';
import { type EmbeddingProvider, type EmbeddingProviderInfo, l2normalize } from './provider.js';

const BATCH = 8;

/**
 * Local embeddings with native ONNX Runtime (CPU) and the pure-JS Hugging Face tokenizer.
 * ~7x faster than the WASM backend on the benchmark corpus; text never leaves the process.
 */
export class OnnxEmbeddingProvider implements EmbeddingProvider {
	readonly info: EmbeddingProviderInfo;

	private constructor(
		private readonly spec: LocalModelSpec,
		private readonly ort: typeof Ort,
		private readonly session: Ort.InferenceSession,
		private readonly tokenizer: Tokenizer,
	) {
		// Pinned models are identified by their revision; manifest models by their graph's hash (or size when unpinned).
		const graph = spec.files.find(f => f.path === spec.modelFile);
		const identity = spec.revision
			? `${spec.repo}@${spec.revision.slice(0, 12)}:q8`
			: `${spec.id}@${graph?.sha256?.slice(0, 12) ?? `size${graph?.size ?? 0}`}`;
		this.info = {
			fingerprint: `onnx:${identity}:${spec.pooling}`,
			displayName: spec.displayName,
			dims: spec.dims,
			local: true,
		};
	}

	static async create(spec: LocalModelSpec, modelDir: string, threads = 4): Promise<OnnxEmbeddingProvider> {
		// Loaded lazily so lexical-only use never touches the native binding.
		const mod = (await import('onnxruntime-node')) as typeof Ort & { default?: typeof Ort };
		const ort = mod.default ?? mod;
		const tokenizer = new Tokenizer(
			JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8')),
			JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer_config.json'), 'utf8')),
		);
		const session = await ort.InferenceSession.create(path.join(modelDir, ...spec.modelFile.split('/')), {
			executionProviders: ['cpu'],
			intraOpNumThreads: threads,
			interOpNumThreads: 1,
			graphOptimizationLevel: 'all',
		});
		return new OnnxEmbeddingProvider(spec, ort, session, tokenizer);
	}

	async embedQuery(text: string): Promise<Float32Array> {
		const [v] = await this.run([this.spec.queryPrefix + text]);
		return v!;
	}

	async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
		const out = new Array<Float32Array>(texts.length);
		// Batch similar lengths together to minimize padding.
		const order = texts
			.map((t, i) => [i, t.length] as const)
			.sort((a, b) => a[1] - b[1])
			.map(x => x[0]);
		for (let b = 0; b < order.length; b += BATCH) {
			const idx = order.slice(b, b + BATCH);
			const vecs = await this.run(idx.map(i => this.spec.documentPrefix + texts[i]!));
			for (const [j, i] of idx.entries()) {
				out[i] = vecs[j]!;
			}
		}
		return out;
	}

	private encode(text: string): number[] {
		const ids = this.tokenizer.encode(text).ids;
		if (ids.length <= this.spec.maxTokens) {
			return ids;
		}
		// Keep [CLS] ... and the final [SEP].
		return [...ids.slice(0, this.spec.maxTokens - 1), ids.at(-1)!];
	}

	private async run(texts: readonly string[]): Promise<Float32Array[]> {
		const encoded = texts.map(t => this.encode(t));
		const maxLen = Math.max(...encoded.map(e => e.length));
		const n = encoded.length;
		const ids = new BigInt64Array(n * maxLen);
		const mask = new BigInt64Array(n * maxLen);
		encoded.forEach((e, i) => {
			for (let j = 0; j < e.length; j++) {
				ids[i * maxLen + j] = BigInt(e[j]!);
				mask[i * maxLen + j] = 1n;
			}
		});
		const { Tensor } = this.ort;
		const feeds: Record<string, Ort.Tensor> = {
			input_ids: new Tensor('int64', ids, [n, maxLen]),
			attention_mask: new Tensor('int64', mask, [n, maxLen]),
		};
		if (this.session.inputNames.includes('token_type_ids')) {
			feeds.token_type_ids = new Tensor('int64', new BigInt64Array(n * maxLen), [n, maxLen]);
		}
		const outputs = await this.session.run(feeds);
		const hidden = outputs.last_hidden_state ?? outputs[this.session.outputNames[0]!]!;
		const data = hidden.data as Float32Array;
		const dims = this.spec.dims;
		const result: Float32Array[] = [];
		for (let i = 0; i < n; i++) {
			const v = new Float32Array(dims);
			if (this.spec.pooling === 'cls') {
				v.set(data.subarray(i * maxLen * dims, i * maxLen * dims + dims));
			} else {
				const len = encoded[i]!.length;
				for (let t = 0; t < len; t++) {
					const off = (i * maxLen + t) * dims;
					for (let d = 0; d < dims; d++) {
						v[d] = v[d]! + data[off + d]!;
					}
				}
				for (let d = 0; d < dims; d++) {
					v[d] = v[d]! / len;
				}
			}
			result.push(l2normalize(v));
		}
		return result;
	}

	async dispose(): Promise<void> {
		await this.session.release();
	}
}
