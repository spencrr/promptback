import type { ExploreResult, IndexStatus, PromptRecord, SessionInfo, SessionOpenTarget, SourceCatalog, SyncProgress } from '@promptback/core/types';

export type ExplorerView = 'table' | 'graph';

/** Actions on a prompt (all handled by the extension so they work identically to the quick picker). */
export type PromptAction = 'copy' | 'insert' | 'preview' | 'open';

/** Settings the Index panel can change (keys under `promptback.`). */
export interface IndexSettings {
	/** An embedding provider id (`local`, `openai-compatible`, `none`, or a registered plugin). */
	readonly provider: string;
	readonly model: string;
	readonly threads: number;
	readonly embedOrigins: readonly string[];
	readonly allowDownload: boolean;
	readonly openaiBaseUrl: string;
	readonly openaiModel: string;
	readonly backgroundIntervalMinutes: number;
}

/** What the Index panel can offer: the registered providers and local models. */
export interface IndexChoices {
	readonly providers: readonly { readonly id: string; readonly label: string; readonly description: string; readonly local: boolean }[];
	readonly models: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
}

export type IndexAction = 'reindex' | 'pause' | 'resume' | 'rebuild' | 'openSettings' | 'showLog' | 'revealIndex';

/** Where to open: query text, view, optionally a prompt to select once results arrive, and a panel to show. */
export interface OpenRequest {
	readonly query: string;
	readonly view?: ExplorerView;
	readonly selectId?: string;
	readonly panel?: 'index';
}

export type ToWebview =
	| ({ readonly type: 'init'; readonly reducedMotion: boolean; readonly catalog: SourceCatalog } & Partial<OpenRequest>)
	| { readonly type: 'result'; readonly requestId: number; readonly result: ExploreResult }
	| { readonly type: 'error'; readonly requestId: number; readonly message: string }
	| {
		readonly type: 'detail';
		readonly requestId: number;
		readonly prompt: PromptRecord;
		readonly session?: SessionInfo;
		/** Every prompt of the session (text truncated) for the context strip. */
		readonly sessionPrompts: readonly Pick<PromptRecord, 'id' | 'seq' | 'timestamp' | 'origin' | 'text'>[];
		readonly openTargets: readonly SessionOpenTarget[];
	}
	/** The index changed (new prompts / embeddings); the webview re-runs its query in place. */
	| { readonly type: 'indexChanged' }
	| ({ readonly type: 'open' } & OpenRequest)
	| {
		readonly type: 'indexStatus';
		readonly status?: IndexStatus & { syncing: boolean };
		readonly settings: IndexSettings;
		readonly choices: IndexChoices;
		readonly error?: string;
	}
	| { readonly type: 'progress'; readonly progress: SyncProgress };

export type FromWebview =
	| { readonly type: 'ready' }
	| { readonly type: 'query'; readonly requestId: number; readonly text: string }
	| { readonly type: 'detail'; readonly requestId: number; readonly promptId: string }
	| { readonly type: 'action'; readonly action: PromptAction; readonly promptId: string }
	| { readonly type: 'indexStatus' }
	| { readonly type: 'setSetting'; readonly key: keyof IndexSettings; readonly value: unknown }
	| { readonly type: 'indexAction'; readonly action: IndexAction };
