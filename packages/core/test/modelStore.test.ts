import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type LocalModelSpec, localModelSpecSchema, modelFileUrl } from '../src/embed/models.js';
import { downloadModel, resolveModelDir } from '../src/embed/modelStore.js';

let tmp: string;

/** A tiny two-file "model" with pinned hashes, served by an in-memory transport. */
const files = {
	'onnx/model.onnx': Buffer.from('not really a model, but hashed like one'),
	'tokenizer.json': Buffer.from('{"version":"1.0"}'),
};
const spec: LocalModelSpec = localModelSpecSchema.parse({
	id: 'tiny-test-model',
	displayName: 'Tiny',
	repo: 'test/tiny',
	revision: 'abc123def456',
	dims: 4,
	maxTokens: 8,
	pooling: 'mean',
	modelFile: 'onnx/model.onnx',
	files: Object.entries(files).map(([p, buf]) => ({ path: p, size: buf.length, sha256: sha256(buf) })),
});

function sha256(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

/** Serves the fixture files by URL and records every request; `tamper` corrupts one file's bytes. */
function fakeFetch(opts: { tamper?: string; status?: number } = {}) {
	const requests: string[] = [];
	const fetchImpl: typeof fetch = input => {
		const url = String(input);
		requests.push(url);
		const file = Object.keys(files).find(p => url.endsWith(`/${p}`));
		if (!file || opts.status) {
			return Promise.resolve(new Response('nope', { status: opts.status ?? 404, statusText: 'Not Found' }));
		}
		let body = files[file as keyof typeof files];
		if (opts.tamper === file) {
			body = Buffer.from(body.map(b => b ^ 1));
		}
		return Promise.resolve(new Response(new Uint8Array(body), { status: 200 }));
	};
	return { fetch: fetchImpl, requests };
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-models-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('model store', () => {
	it('builds pinned download URLs', () => {
		expect(modelFileUrl(spec, spec.files[0]!)).toBe('https://huggingface.co/test/tiny/resolve/abc123def456/onnx/model.onnx');
		expect(modelFileUrl(spec, spec.files[0]!, 'https://mirror.example/hf/')).toBe('https://mirror.example/hf/test/tiny/resolve/abc123def456/onnx/model.onnx');
		expect(() => modelFileUrl({ ...spec, repo: '' }, spec.files[0]!)).toThrow(/no download location/);
	});

	it('downloads into the cache, verifies hashes and marks the folder verified', async () => {
		const { fetch: f, requests } = fakeFetch();
		const progress: string[] = [];
		const dir = await resolveModelDir(spec, { cacheDir: tmp, allowDownload: true, fetch: f, onProgress: m => progress.push(m) });
		expect(dir).toBe(path.join(tmp, spec.id));
		expect(requests).toHaveLength(2);
		expect(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')).toBe('{"version":"1.0"}');
		expect(fs.readFileSync(path.join(dir, '.verified'), 'utf8')).toBe(spec.revision);
		expect(progress.join('\n')).toMatch(/Downloading test\/tiny\/onnx\/model.onnx/);
		// Second resolution is served from the cache without any request.
		const again = fakeFetch();
		expect(await resolveModelDir(spec, { cacheDir: tmp, allowDownload: true, fetch: again.fetch })).toBe(dir);
		expect(again.requests).toEqual([]);
	});

	it('rejects a download whose bytes do not match the pinned hash and leaves no partial folder', async () => {
		const { fetch: f } = fakeFetch({ tamper: 'onnx/model.onnx' });
		await expect(resolveModelDir(spec, { cacheDir: tmp, allowDownload: true, fetch: f })).rejects.toThrow(/Integrity check failed for onnx\/model.onnx/);
		expect(fs.existsSync(path.join(tmp, spec.id))).toBe(false);
		expect(fs.readdirSync(tmp)).toEqual([]);
	});

	it('reports HTTP failures and refuses to download when downloads are off', async () => {
		await expect(resolveModelDir(spec, { cacheDir: tmp, allowDownload: true, fetch: fakeFetch({ status: 503 }).fetch })).rejects.toThrow(/failed: 503/);
		await expect(resolveModelDir(spec, { cacheDir: tmp, allowDownload: false, fetch: fakeFetch().fetch })).rejects.toThrow(/downloads are disabled/);
	});

	it('prefers an explicit model directory and read-only search directories over the cache', async () => {
		const explicit = path.join(tmp, 'explicit');
		for (const [p, buf] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(explicit, p)), { recursive: true });
			fs.writeFileSync(path.join(explicit, p), buf);
		}
		const noNetwork = fakeFetch({ status: 500 }).fetch;
		expect(await resolveModelDir(spec, { modelDir: explicit, cacheDir: tmp, allowDownload: false, fetch: noNetwork })).toBe(explicit);
		await expect(resolveModelDir(spec, { modelDir: path.join(tmp, 'missing'), cacheDir: tmp, allowDownload: false })).rejects.toThrow(/does not contain the expected files/);

		const bundled = path.join(tmp, 'bundled');
		fs.cpSync(explicit, path.join(bundled, spec.id), { recursive: true });
		expect(await resolveModelDir(spec, { searchDirs: [bundled], cacheDir: path.join(tmp, 'cache'), allowDownload: false, fetch: noNetwork })).toBe(path.join(bundled, spec.id));
	});

	it('refuses to download a manifest model without pinned hashes', async () => {
		const unpinned = { ...spec, files: spec.files.map(f => ({ path: f.path, size: f.size })) };
		await expect(downloadModel(unpinned, path.join(tmp, 'x'), { fetch: fakeFetch().fetch })).rejects.toThrow(/pins no sha256/);
	});
});
