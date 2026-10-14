import * as z from 'zod/v4';
import { type ConfigurablePlugin, parseOptions, Registry } from '../registry.js';
import { resolveModelDir } from './modelStore.js';
import { DEFAULT_LOCAL_MODEL, getModelSpec, loadModelManifest } from './models.js';
import { OnnxEmbeddingProvider } from './onnx.js';
import { OpenAICompatibleEmbeddingProvider } from './openai.js';
import type { EmbeddingProvider } from './provider.js';

/** What the engine gives a provider plugin besides its own options. */
export interface ProviderEnvironment {
	/** Writable cache root for downloaded models (`<indexDir>/models`). */
	readonly cacheDir: string;
	/** Extra read-only directories holding `<modelId>/...`. */
	readonly searchDirs?: readonly string[];
	readonly allowDownload: boolean;
	/** Hugging Face compatible mirror base URL. */
	readonly mirror?: string;
	readonly onProgress?: (message: string) => void;
	/** Transport for model downloads and remote embeddings (defaults to the global `fetch`). */
	readonly fetch?: typeof fetch;
}

/**
 * An embedding backend. `id` is the `kind` users write in their configuration; `options` validates the rest of it.
 * `create` returns `undefined` for a backend that provides no vectors (keyword-only search).
 */
export interface EmbeddingProviderPlugin<O = unknown> extends ConfigurablePlugin<O> {
	readonly label: string;
	readonly description: string;
	/** True when text never leaves the machine. */
	readonly local: boolean;
	// biome-ignore lint/style/useConsistentMethodSignatures: a method signature is bivariant in O, so plugins with specific option types fit one registry.
	create(options: O, env: ProviderEnvironment): Promise<EmbeddingProvider | undefined>;
}

export const localProviderOptions = z.object({
	/** Registry id, e.g. `bge-small-en-v1.5`. Ignored when `modelDir` holds a `model.json` manifest. */
	model: z.string().min(1).default(DEFAULT_LOCAL_MODEL),
	/** Directory containing the model files (offline machines, or a custom model described by `model.json`). */
	modelDir: z.string().min(1).optional(),
	threads: z.number().int().min(1).max(64).default(4),
});

export const openAICompatibleProviderOptions = z.object({
	/** Base URL up to (not including) `/embeddings`, e.g. `https://<res>.openai.azure.com/openai/v1`. */
	baseUrl: z.url(),
	model: z.string().min(1),
	/** Name of the environment variable holding the API key. The key itself is never part of the configuration. */
	apiKeyEnv: z.string().min(1).optional(),
	/** Requested dimensions; omit for the model's native size. */
	dims: z.number().int().positive().optional(),
	headers: z.record(z.string(), z.string()).optional(),
});

export const noneProviderOptions = z.object({});

export const localProvider: EmbeddingProviderPlugin<z.infer<typeof localProviderOptions>> = {
	id: 'local',
	label: 'Local ONNX model',
	description: 'Prompts never leave this machine.',
	local: true,
	options: localProviderOptions,
	async create(o, env) {
		const spec = (o.modelDir && loadModelManifest(o.modelDir)) || getModelSpec(o.model);
		const dir = await resolveModelDir(spec, {
			modelDir: o.modelDir,
			searchDirs: env.searchDirs,
			cacheDir: env.cacheDir,
			allowDownload: env.allowDownload,
			mirror: env.mirror,
			onProgress: env.onProgress,
			fetch: env.fetch,
		});
		return OnnxEmbeddingProvider.create(spec, dir, o.threads);
	},
};

export const openAICompatibleProvider: EmbeddingProviderPlugin<z.infer<typeof openAICompatibleProviderOptions>> = {
	id: 'openai-compatible',
	label: 'OpenAI-compatible endpoint',
	description:
		'Any /embeddings endpoint (Azure OpenAI, Foundry, Ollama, LM Studio). Remote endpoints receive your prompt text.',
	local: false,
	options: openAICompatibleProviderOptions,
	async create(o, env) {
		const p = new OpenAICompatibleEmbeddingProvider({
			baseUrl: o.baseUrl,
			model: o.model,
			apiKey: o.apiKeyEnv ? process.env[o.apiKeyEnv] : undefined,
			dims: o.dims,
			headers: o.headers,
			fetch: env.fetch,
		});
		// Resolve dimensions up front so the vector matrix can be sized.
		if (!p.info.dims) {
			await p.embedQuery('dimension probe');
		}
		return p;
	},
};

export const noneProvider: EmbeddingProviderPlugin<z.infer<typeof noneProviderOptions>> = {
	id: 'none',
	label: 'Keyword search only',
	description: 'No embeddings; searches match words only.',
	local: true,
	options: noneProviderOptions,
	create: () => Promise.resolve(undefined),
};

/** The embedding backends an engine can use. Register another plugin before opening an engine to add one. */
export const embeddingProviders = new Registry<EmbeddingProviderPlugin>('embedding provider', [
	localProvider,
	openAICompatibleProvider,
	noneProvider,
]);

/** Configuration of a built-in backend (`kind` selects the plugin; the rest are its options). */
export type EmbeddingConfig =
	| ({ readonly kind: 'local' } & Partial<z.input<typeof localProviderOptions>>)
	| ({ readonly kind: 'openai-compatible' } & z.input<typeof openAICompatibleProviderOptions>)
	| { readonly kind: 'none' }
	| { readonly kind: string; readonly [option: string]: unknown };

/** Id of the backend that provides no vectors. */
export const NO_EMBEDDING = 'none';

/** Validates `config` against its plugin's schema and instantiates the provider. Every failure is a rejection. */
export function createEmbeddingProvider(
	config: EmbeddingConfig,
	env: ProviderEnvironment,
	registry: Registry<EmbeddingProviderPlugin> = embeddingProviders,
): Promise<EmbeddingProvider | undefined> {
	try {
		const { kind, ...rest } = config;
		const plugin = registry.require(kind);
		return plugin.create(parseOptions(registry.kind, plugin, rest), env);
	} catch (e) {
		return Promise.reject(e);
	}
}
