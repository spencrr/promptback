export { HashedEmbeddingProvider } from './embed/hashed.js';
export { downloadModel, resolveModelDir } from './embed/modelStore.js';
export {
	DEFAULT_LOCAL_MODEL,
	getModelSpec,
	LOCAL_MODELS,
	type LocalModelSpec,
	loadModelManifest,
	localModelSpecSchema,
	localModels,
	MODEL_MANIFEST,
	type ModelFile,
} from './embed/models.js';
export type { EmbeddingProvider, EmbeddingProviderInfo } from './embed/provider.js';
export {
	createEmbeddingProvider,
	type EmbeddingConfig,
	type EmbeddingProviderPlugin,
	embeddingProviders,
	hashedProvider,
	localProvider,
	NO_EMBEDDING,
	noneProvider,
	openAICompatibleProvider,
	type ProviderEnvironment,
} from './embed/registry.js';
export {
	type EngineOptions,
	migrateSourceSettings,
	PromptSearchEngine,
	type SourceOptionsById,
	type SyncOptions,
} from './engine.js';
export { agentsWindowLink, type SessionOpenTarget, sessionOpenTargets } from './links.js';
export { copilotHome, defaultIndexDir, vscodeUserDataRoots } from './paths.js';
export type { HostEvent, HostInitOptions, HostMethods, HostRequest, HostResponse } from './protocol.js';
export {
	type ConfigurablePlugin,
	type Plugin,
	PluginOptionsError,
	parseOptions,
	Registry,
	RegistryError,
} from './registry.js';
export { type Chunk, type ChunkOptions, chunkText, DEFAULT_CHUNK_OPTIONS } from './search/chunk.js';
export { type ParsedQuery, parseDateRange, parseQuery } from './search/query.js';
export { DEFAULT_RANKING, type RankingOptions } from './search/searcher.js';
export { agentHostSource } from './sources/agentHostSource.js';
export { claudeCodeSource, claudeHome } from './sources/claudeCode.js';
export { codexHome, codexSource } from './sources/codex.js';
export { copilotSource } from './sources/copilotSource.js';
export {
	baseSourceOptions,
	clientLabel,
	type PromptSourcePlugin,
	promptSources,
	type SourceContext,
	type SourceStore,
	type SourceSyncResult,
	sourceAliases,
	sourceCatalog,
} from './sources/registry.js';
export { type SessionFileRead, syncSessionFiles } from './sources/sessionFiles.js';
export { replayMutationLog } from './sources/vscodeChat.js';
export { vscodeChatSource } from './sources/vscodeChatSource.js';
export type { StoredPrompt } from './store.js';
export * from './types.js';
