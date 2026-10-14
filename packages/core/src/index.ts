export * from './types.js';
export { PromptSearchEngine, migrateSourceSettings, type EngineOptions, type SourceOptionsById, type SyncOptions } from './engine.js';
export { Registry, RegistryError, PluginOptionsError, parseOptions, type Plugin, type ConfigurablePlugin } from './registry.js';
export type { EmbeddingProvider, EmbeddingProviderInfo } from './embed/provider.js';
export {
	embeddingProviders,
	createEmbeddingProvider,
	localProvider,
	openAICompatibleProvider,
	noneProvider,
	NO_EMBEDDING,
	type EmbeddingConfig,
	type EmbeddingProviderPlugin,
	type ProviderEnvironment,
} from './embed/registry.js';
export {
	LOCAL_MODELS,
	DEFAULT_LOCAL_MODEL,
	MODEL_MANIFEST,
	localModels,
	localModelSpecSchema,
	getModelSpec,
	loadModelManifest,
	type LocalModelSpec,
	type ModelFile,
} from './embed/models.js';
export { downloadModel, resolveModelDir } from './embed/modelStore.js';
export {
	promptSources,
	sourceCatalog,
	sourceAliases,
	clientLabel,
	baseSourceOptions,
	type PromptSourcePlugin,
	type SourceContext,
	type SourceStore,
	type SourceSyncResult,
} from './sources/registry.js';
export { copilotSource } from './sources/copilotSource.js';
export { vscodeChatSource } from './sources/vscodeChatSource.js';
export { agentHostSource } from './sources/agentHostSource.js';
export { claudeCodeSource, claudeHome } from './sources/claudeCode.js';
export { codexSource, codexHome } from './sources/codex.js';
export { syncSessionFiles, type SessionFileRead } from './sources/sessionFiles.js';
export { parseQuery, parseDateRange, type ParsedQuery } from './search/query.js';
export { DEFAULT_RANKING, type RankingOptions } from './search/searcher.js';
export { chunkText, DEFAULT_CHUNK_OPTIONS, type Chunk, type ChunkOptions } from './search/chunk.js';
export { agentsWindowLink, sessionOpenTargets, type SessionOpenTarget } from './links.js';
export { copilotHome, defaultIndexDir, vscodeUserDataRoots } from './paths.js';
export { replayMutationLog } from './sources/vscodeChat.js';
export type { StoredPrompt } from './store.js';
export type { HostEvent, HostInitOptions, HostMethods, HostRequest, HostResponse } from './protocol.js';
