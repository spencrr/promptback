import type { ExploreResult, PromptRecord, SessionInfo } from '@awss/core/types';
import type { SessionOpenTarget } from '@awss/core/types';

export type ExplorerView = 'table' | 'graph';

/** Actions on a prompt (all handled by the extension so they work identically to the quick picker). */
export type PromptAction = 'copy' | 'insert' | 'preview' | 'open';

export type ToWebview =
	| { readonly type: 'init'; readonly query: string; readonly reducedMotion: boolean; readonly view?: ExplorerView }
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
	/** The index changed (new prompts / embeddings); the webview re-runs its query if it is idle. */
	| { readonly type: 'indexChanged' }
	| { readonly type: 'setQuery'; readonly query: string; readonly view?: ExplorerView };

export type FromWebview =
	| { readonly type: 'ready' }
	| { readonly type: 'query'; readonly requestId: number; readonly text: string }
	| { readonly type: 'detail'; readonly requestId: number; readonly promptId: string }
	| { readonly type: 'action'; readonly action: PromptAction; readonly promptId: string };
