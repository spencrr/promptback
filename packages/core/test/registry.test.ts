import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { LOCAL_MODELS, loadModelManifest, localModelSpecSchema, localModels } from '../src/embed/models.js';
import { type EmbeddingProviderPlugin, createEmbeddingProvider, embeddingProviders } from '../src/embed/registry.js';
import { PluginOptionsError, Registry, RegistryError, parseOptions } from '../src/registry.js';
import { promptSources, sourceAliases, sourceCatalog } from '../src/sources/registry.js';

const tmps: string[] = [];

afterEach(() => {
	for (const t of tmps.splice(0)) {
		fs.rmSync(t, { recursive: true, force: true });
	}
});

describe('Registry', () => {
	it('registers, looks up and rejects duplicates', () => {
		const r = new Registry<{ id: string }>('thing', [{ id: 'a' }]);
		r.register({ id: 'b' });
		expect(r.ids()).toEqual(['a', 'b']);
		expect(r.get('a')).toEqual({ id: 'a' });
		expect(r.has('c')).toBe(false);
		expect(() => r.register({ id: 'a' })).toThrow(RegistryError);
		expect(() => r.require('c')).toThrow(/Unknown thing 'c'\. Known: a, b/);
	});

	it('validates plugin options with readable errors', () => {
		const plugin = { id: 'p', options: z.object({ n: z.number().int().min(1).default(1), s: z.string().optional() }) };
		expect(parseOptions('widget', plugin, undefined)).toEqual({ n: 1 });
		expect(parseOptions('widget', plugin, { n: 3, s: 'x' })).toEqual({ n: 3, s: 'x' });
		let error: unknown;
		try {
			parseOptions('widget', plugin, { n: 0, s: 5 });
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(PluginOptionsError);
		expect((error as Error).message).toMatch(/^Invalid options for widget 'p': n: .*; s: /);
	});
});

describe('embedding provider registry', () => {
	it('knows the built-ins and validates their options', async () => {
		expect(embeddingProviders.ids()).toEqual(['local', 'openai-compatible', 'none']);
		expect(await createEmbeddingProvider({ kind: 'none' }, { cacheDir: 'x', allowDownload: false })).toBeUndefined();
		await expect(createEmbeddingProvider({ kind: 'openai-compatible', baseUrl: 'not a url', model: '' }, { cacheDir: 'x', allowDownload: false }))
			.rejects.toThrow(/Invalid options for embedding provider 'openai-compatible': baseUrl: .*; model: /);
		await expect(createEmbeddingProvider({ kind: 'nope' }, { cacheDir: 'x', allowDownload: false })).rejects.toThrow(/Unknown embedding provider 'nope'/);
	});

	it('accepts a third-party provider through its own registry', async () => {
		const fake: EmbeddingProviderPlugin<{ dims: number }> = {
			id: 'fake',
			label: 'Fake',
			description: '',
			local: true,
			options: z.object({ dims: z.number().int().positive() }),
			create: o =>
				Promise.resolve({
					info: { fingerprint: `fake:${o.dims}`, displayName: 'fake', dims: o.dims, local: true },
					embedDocuments: texts => Promise.resolve(texts.map(() => new Float32Array(o.dims))),
					embedQuery: () => Promise.resolve(new Float32Array(o.dims)),
					dispose: () => Promise.resolve(),
				}),
		};
		const registry = new Registry<EmbeddingProviderPlugin>('embedding provider', [fake]);
		const p = await createEmbeddingProvider({ kind: 'fake', dims: 8 }, { cacheDir: 'x', allowDownload: false }, registry);
		expect(p?.info.dims).toBe(8);
	});
});

describe('local model registry', () => {
	it('registers the pinned built-ins', () => {
		expect(localModels.ids()).toEqual(LOCAL_MODELS.map(m => m.id));
		for (const m of LOCAL_MODELS) {
			expect(localModelSpecSchema.parse(m)).toEqual(m);
			expect(m.files.every(f => f.sha256)).toBe(true);
		}
	});

	it('loads and validates a model.json manifest', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-model-'));
		tmps.push(dir);
		expect(loadModelManifest(dir)).toBeUndefined();
		fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ id: 'my-model', displayName: 'Mine', dims: 0, maxTokens: 128, pooling: 'mean', files: [] }));
		expect(() => loadModelManifest(dir)).toThrow(/not a valid model manifest: dims: .*; files: /);
		fs.writeFileSync(
			path.join(dir, 'model.json'),
			JSON.stringify({ id: 'my-model', displayName: 'Mine', dims: 256, maxTokens: 128, pooling: 'mean', modelFile: 'model.onnx', files: [{ path: 'model.onnx', size: 10 }] }),
		);
		const spec = loadModelManifest(dir);
		expect(spec).toMatchObject({ id: 'my-model', dims: 256, repo: '', modelFile: 'model.onnx' });
		expect(localModels.get('my-model')).toEqual(spec);
		// Re-reading the same manifest is fine; redefining the id differently is not.
		expect(loadModelManifest(dir)).toEqual(spec);
		fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ ...spec, dims: 128 }));
		expect(() => loadModelManifest(dir)).toThrow(/redefines model 'my-model'/);
	});
});

describe('prompt source registry', () => {
	it('exposes the built-in sources, their clients and query aliases', () => {
		expect(promptSources.ids()).toEqual(['copilot', 'vscode-chat', 'agent-host', 'claude-code', 'codex']);
		const catalog = sourceCatalog();
		expect(Object.keys(catalog.clients).sort()).toEqual([
			'claude/cli', 'claude/sdk', 'claude/vscode', 'codex/cli', 'codex/exec', 'codex/vscode', 'github/autopilot', 'github/cli', 'vscode-agent-host', 'vscode-chat',
		]);
		const aliases = sourceAliases();
		expect(aliases.sources.get('cli')).toBe('copilot');
		expect(aliases.sources.get('chat')).toBe('vscode-chat');
		expect(aliases.sources.get('claude')).toBe('claude-code');
		expect(aliases.clients.get('autopilot')).toBe('github/autopilot');
		// Bare claude / codex are not aliases: as substrings they match every client of that source.
		expect(aliases.clients.get('codex')).toBeUndefined();
		expect(aliases.clients.get('codex-cli')).toBe('codex/cli');
		// Every alias resolves to exactly one id: no two clients may claim the same word.
		const words = promptSources.list().flatMap(s => s.clients.flatMap(c => [c.id, ...c.aliases]));
		expect(new Set(words).size).toBe(words.length);
	});

	it('gives every source a schema with an `enabled` default', () => {
		for (const s of promptSources.list()) {
			expect(parseOptions('prompt source', s, {})).toMatchObject({ enabled: true });
			expect(parseOptions('prompt source', s, { enabled: false })).toMatchObject({ enabled: false });
		}
	});
});
