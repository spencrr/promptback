/** Where a prompt was recorded. */
export type SourceKind = 'copilot' | 'vscode-chat';

/**
 * Who authored a prompt.
 * - `human`: typed by the user (Copilot events with no `data.source`; VS Code chat requests not system-initiated)
 * - `agent`: message delivered from/to a background agent (`data.source = agent-*`)
 * - `skill`: skill content injected as a user message (`data.source = skill-*`)
 * - `system`: system notifications / system-initiated chat requests
 * - `autopilot`: automatic autopilot continuations
 */
export type PromptOrigin = 'human' | 'agent' | 'skill' | 'system' | 'autopilot';

export const ALL_ORIGINS: readonly PromptOrigin[] = ['human', 'agent', 'skill', 'system', 'autopilot'];

export interface SessionInfo {
	/** Globally unique key, e.g. `copilot:<sessionId>` or `vscode-chat:<product>:<sessionId>`. */
	readonly key: string;
	readonly source: SourceKind;
	/** Native session id (Copilot SDK session id or VS Code chat session id). */
	readonly sessionId: string;
	readonly title?: string;
	readonly cwd?: string;
	readonly repository?: string;
	readonly branch?: string;
	/** Copilot `client_name` (e.g. `vscode-agent-host`, `github/cli`) or `vscode-chat`. */
	readonly client?: string;
	/** VS Code product folder (`Code`, `Code - Insiders`) for VS Code-owned data. */
	readonly product?: string;
	/** Workspace folder/file URI the VS Code chat session belongs to. */
	readonly workspaceUri?: string;
	/** Agents-window (agent host) session id, when this Copilot session was created or adopted by VS Code. */
	readonly agentHostSessionId?: string;
	/** Peer chat id inside the agent-host session, when this Copilot session is a secondary chat. */
	readonly agentHostChatId?: string;
	readonly createdAt?: number;
	readonly updatedAt?: number;
}

export interface PromptRecord {
	/** Stable occurrence id (unique per source/session/event). */
	readonly id: string;
	readonly sessionKey: string;
	readonly text: string;
	/** Epoch milliseconds. */
	readonly timestamp: number;
	readonly origin: PromptOrigin;
	/** 0-based order within its session. */
	readonly seq: number;
	readonly model?: string;
}

export interface SearchFilters {
	/** Substring match (case-insensitive) on repository, e.g. `PyRIT`. */
	readonly repo?: string;
	/** Substring match on client (`agent-host`, `cli`, `autopilot`, `vscode-chat`). */
	readonly client?: string;
	readonly source?: SourceKind;
	/** Substring match on cwd / workspace. */
	readonly cwd?: string;
	/** Epoch ms, inclusive. */
	readonly after?: number;
	/** Epoch ms, exclusive. */
	readonly before?: number;
	/** Defaults to `['human']`. */
	readonly origins?: readonly PromptOrigin[];
	readonly sessionKey?: string;
}

export type SearchMode = 'hybrid' | 'semantic' | 'lexical';

export interface SearchQuery {
	readonly text: string;
	readonly limit?: number;
	readonly mode?: SearchMode;
	readonly filters?: SearchFilters;
	/** Collapse identical prompt texts into one hit (default true). */
	readonly collapseDuplicates?: boolean;
}

export interface SearchHit {
	readonly prompt: PromptRecord;
	readonly session: SessionInfo;
	readonly score: number;
	/** 1-based ranks in each retriever, when the prompt was retrieved by it. */
	readonly lexicalRank?: number;
	readonly semanticRank?: number;
	/** Character range of the best matching chunk within `prompt.text`. */
	readonly matchRange?: readonly [start: number, end: number];
	/** Other occurrences of the same text that were collapsed into this hit. */
	readonly duplicates: readonly { readonly promptId: string; readonly sessionKey: string; readonly timestamp: number }[];
}

export interface SearchResult {
	readonly query: string;
	/** The free text left after stripping filter tokens. */
	readonly freeText: string;
	readonly filters: SearchFilters;
	readonly mode: SearchMode;
	/** True when semantic retrieval was requested but unavailable (no model / embeddings pending). */
	readonly semanticUnavailable: boolean;
	readonly hits: readonly SearchHit[];
	readonly tookMs: number;
}

export interface IndexStatus {
	readonly indexPath: string;
	readonly sessions: number;
	readonly prompts: number;
	readonly promptsByOrigin: Readonly<Record<string, number>>;
	readonly promptsBySource: Readonly<Record<string, number>>;
	readonly chunks: number;
	readonly embeddedChunks: number;
	readonly model?: string;
	readonly lastSyncAt?: number;
	readonly errors: readonly string[];
}

export interface SyncProgress {
	readonly phase: 'scan' | 'embed' | 'done';
	readonly message: string;
	readonly done?: number;
	readonly total?: number;
}

export interface SyncResult {
	readonly addedPrompts: number;
	readonly removedPrompts: number;
	readonly embeddedChunks: number;
	readonly pendingChunks: number;
	readonly errors: readonly string[];
	readonly tookMs: number;
	/** False when another process holds the writer lease and this call did nothing. */
	readonly leader: boolean;
}
