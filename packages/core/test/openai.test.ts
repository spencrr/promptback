import { describe, expect, it } from 'vitest';
import { OpenAICompatibleEmbeddingProvider } from '../src/embed/openai.js';
import { createEmbeddingProvider } from '../src/embed/registry.js';

interface Captured {
	url: string;
	headers: Record<string, string>;
	body: { model: string; input: string[]; dimensions?: number };
}

/** An in-memory /embeddings endpoint: returns unit vectors whose direction encodes the input's length. */
function fakeEndpoint(opts: { dims?: number; status?: number } = {}) {
	const calls: Captured[] = [];
	const dims = opts.dims ?? 3;
	const fetchImpl: typeof fetch = (input, init) => {
		const body = JSON.parse(String(init?.body)) as Captured['body'];
		calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body });
		if (opts.status) {
			return Promise.resolve(
				new Response('{"error":"quota"}', { status: opts.status, statusText: 'Too Many Requests' }),
			);
		}
		// Returned out of order on purpose: clients must sort by index.
		const data = body.input
			.map((text, index) => ({
				index,
				embedding: Array.from({ length: dims }, (_, d) => (d === 0 ? text.length : d)),
			}))
			.reverse();
		return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
	};
	return { fetch: fetchImpl, calls };
}

describe('OpenAI-compatible embedding provider', () => {
	it('posts to {baseUrl}/embeddings with the key in both header styles and parses vectors in input order', async () => {
		const ep = fakeEndpoint();
		const p = new OpenAICompatibleEmbeddingProvider({
			baseUrl: 'https://example.openai.azure.com/openai/v1/',
			model: 'text-embedding-3-small',
			apiKey: 'sk-secret',
			dims: 3,
			headers: { 'x-tenant': 't1' },
			fetch: ep.fetch,
		});
		const vecs = await p.embedDocuments(['a', 'abcd']);
		expect(ep.calls).toHaveLength(1);
		expect(ep.calls[0]!.url).toBe('https://example.openai.azure.com/openai/v1/embeddings');
		expect(ep.calls[0]!.headers).toMatchObject({
			authorization: 'Bearer sk-secret',
			'api-key': 'sk-secret',
			'x-tenant': 't1',
		});
		expect(ep.calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'abcd'], dimensions: 3 });
		// Order restored and L2-normalised.
		expect(vecs[0]![0]).toBeLessThan(vecs[1]![0]!);
		for (const v of vecs) {
			expect(Math.hypot(...v)).toBeCloseTo(1, 6);
		}
		expect(p.info).toMatchObject({
			dims: 3,
			local: false,
			displayName: 'text-embedding-3-small @ example.openai.azure.com',
		});
	});

	it('treats loopback endpoints as local, batches long inputs and probes dimensions when unknown', async () => {
		const ep = fakeEndpoint({ dims: 5 });
		const p = new OpenAICompatibleEmbeddingProvider({
			baseUrl: 'http://localhost:11434/v1',
			model: 'nomic',
			batchSize: 2,
			maxChars: 4,
			fetch: ep.fetch,
		});
		expect(p.info.local).toBe(true);
		expect(p.info.dims).toBe(0);
		await p.embedDocuments(['one', 'two', 'three-is-long']);
		expect(ep.calls.map(c => c.body.input)).toEqual([['one', 'two'], ['thre']]);
		expect(ep.calls[0]!.headers).not.toHaveProperty('authorization');
		expect(p.info.dims).toBe(5);
	});

	it('surfaces HTTP errors with the response body but never the key', async () => {
		const ep = fakeEndpoint({ status: 429 });
		const p = new OpenAICompatibleEmbeddingProvider({
			baseUrl: 'https://api.example.com/v1',
			model: 'm',
			apiKey: 'sk-secret',
			fetch: ep.fetch,
		});
		let message = '';
		try {
			await p.embedQuery('x');
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).toMatch(/429 Too Many Requests .*quota/u);
		expect(message).not.toContain('sk-secret');
		expect(JSON.stringify(p)).not.toContain('sk-secret');
		expect(JSON.stringify(p)).toContain('"apiKey":"[redacted]"');
	});

	it('is created through the registry from the environment variable the user names', async () => {
		const ep = fakeEndpoint({ dims: 2 });
		process.env.PROMPTBACK_TEST_KEY = 'sk-from-env';
		try {
			const p = await createEmbeddingProvider(
				{
					kind: 'openai-compatible',
					baseUrl: 'https://api.example.com/v1',
					model: 'm',
					apiKeyEnv: 'PROMPTBACK_TEST_KEY',
				},
				{ cacheDir: 'unused', allowDownload: false, fetch: ep.fetch },
			);
			// The dimension probe ran once at creation.
			expect(ep.calls).toHaveLength(1);
			expect(ep.calls[0]!.headers.authorization).toBe('Bearer sk-from-env');
			expect(p?.info.dims).toBe(2);
		} finally {
			delete process.env.PROMPTBACK_TEST_KEY;
		}
	});
});
