import { type EmbeddingProvider, type EmbeddingProviderInfo, l2normalize } from './provider.js';

export interface OpenAICompatibleOptions {
	/** Base URL up to (not including) `/embeddings`, e.g. `https://<res>.openai.azure.com/openai/v1` or `http://localhost:11434/v1`. */
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey?: string;
	readonly dims?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly batchSize?: number;
	/** Max characters sent per input; longer chunks are cut. */
	readonly maxChars?: number;
	/** Transport (defaults to the global `fetch`); tests substitute an offline one. */
	readonly fetch?: typeof fetch;
}

/** Remote (or loopback) embeddings through the de-facto standard `POST {baseUrl}/embeddings` API. */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
	readonly info: EmbeddingProviderInfo;
	private dims: number;

	constructor(private readonly opts: OpenAICompatibleOptions) {
		const url = new URL(opts.baseUrl);
		const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
		this.dims = opts.dims ?? 0;
		this.info = {
			fingerprint: `openai:${url.host}${url.pathname}:${opts.model}:${opts.dims ?? 'native'}`,
			displayName: `${opts.model} @ ${url.host}`,
			dims: this.dims,
			local: loopback,
		};
	}

	/** Serializes without the API key, so logging or persisting a provider can never leak it. */
	toJSON(): Record<string, unknown> {
		const { apiKey, fetch: _fetch, ...rest } = this.opts;
		return { ...rest, apiKey: apiKey ? '[redacted]' : undefined, info: this.info };
	}

	async embedQuery(text: string): Promise<Float32Array> {
		const [v] = await this.call([text]);
		return v!;
	}

	async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
		const size = this.opts.batchSize ?? 64;
		const out: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += size) {
			out.push(...await this.call(texts.slice(i, i + size)));
		}
		return out;
	}

	private async call(input: readonly string[]): Promise<Float32Array[]> {
		const maxChars = this.opts.maxChars ?? 8000;
		const body: Record<string, unknown> = { model: this.opts.model, input: input.map(t => t.slice(0, maxChars)) };
		if (this.opts.dims) {
			body['dimensions'] = this.opts.dims;
		}
		const headers: Record<string, string> = { 'content-type': 'application/json', ...this.opts.headers };
		if (this.opts.apiKey) {
			headers['authorization'] = `Bearer ${this.opts.apiKey}`;
			headers['api-key'] = this.opts.apiKey;
		}
		const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, '')}/embeddings`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			// The response body is included for diagnosis; request headers (the key) never are.
			throw new Error(`Embedding request failed: ${res.status} ${res.statusText} ${(await res.text()).slice(0, 300)}`);
		}
		const json = await res.json() as { data: { index: number; embedding: number[] }[] };
		const vecs = json.data.sort((a, b) => a.index - b.index).map(d => l2normalize(Float32Array.from(d.embedding)));
		if (!this.dims && vecs[0]) {
			this.dims = vecs[0].length;
			(this.info as { dims: number }).dims = this.dims;
		}
		return vecs;
	}

	async dispose(): Promise<void> {
		// stateless
	}
}
