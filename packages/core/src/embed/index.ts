import { getModelSpec } from './models.js';
import { resolveModelDir } from './modelStore.js';
import { OnnxEmbeddingProvider } from './onnx.js';
import { OpenAICompatibleEmbeddingProvider } from './openai.js';
import type { EmbeddingConfig, EmbeddingProvider } from './provider.js';

export interface ProviderEnvironment {
	readonly cacheDir: string;
	readonly searchDirs?: readonly string[];
	readonly allowDownload: boolean;
	readonly mirror?: string;
	readonly onProgress?: (message: string) => void;
}

export async function createEmbeddingProvider(config: EmbeddingConfig, env: ProviderEnvironment): Promise<EmbeddingProvider | undefined> {
	switch (config.kind) {
		case 'none':
			return undefined;
		case 'local': {
			const spec = getModelSpec(config.model);
			const dir = await resolveModelDir(spec, {
				modelDir: config.modelDir,
				searchDirs: env.searchDirs,
				cacheDir: env.cacheDir,
				allowDownload: env.allowDownload,
				mirror: env.mirror,
				onProgress: env.onProgress,
			});
			return OnnxEmbeddingProvider.create(spec, dir, config.threads);
		}
		case 'openai-compatible': {
			const p = new OpenAICompatibleEmbeddingProvider({
				baseUrl: config.baseUrl,
				model: config.model,
				apiKey: config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined,
				dims: config.dims,
				headers: config.headers,
			});
			// Resolve dimensions up front so the vector matrix can be sized.
			if (!p.info.dims) {
				await p.embedQuery('dimension probe');
			}
			return p;
		}
	}
}
