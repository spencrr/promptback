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
	/** True when {@link repository} was inferred from file paths the session's tools touched (workspaceless chats). */
	readonly repositoryInferred?: boolean;
	/** The session had no folder (e.g. an Agents-window chat started without a workspace). */
	readonly workspaceless?: boolean;
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
	/** Session this one was forked from (derived from shared event ids). */
	readonly forkOf?: string;
	/** `seq` of this session's last prompt inherited from {@link forkOf}; later prompts are new in the fork. */
	readonly forkPointSeq?: number;
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
	/** Substring match (case-insensitive) on repository (falls back to cwd), e.g. `PyRIT`. */
	readonly repo?: string;
	readonly branch?: string;
	/** Substring match on client (`vscode-agent-host`, `github/cli`, `github/autopilot`, `vscode-chat`). */
	readonly client?: string;
	readonly source?: SourceKind;
	/** Substring match on cwd / workspace. */
	readonly cwd?: string;
	/** Epoch ms, inclusive. */
	readonly after?: number;
	/** Epoch ms, exclusive. */
	readonly before?: number;
	/** Defaults to `['human']` for {@link SearchQuery}; all origins for explore. */
	readonly origins?: readonly PromptOrigin[];
	/** Session key / id / Agents-window id, or a prefix of one. */
	readonly sessionKey?: string;
	readonly model?: string;
	/** Include trivial acknowledgements ("continue", "yes", ...). Default false for search, true for explore. */
	readonly includeAcks?: boolean;
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
	/** Further matches from the same session that were left out by the per-session cap. */
	readonly moreInSession: number;
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

/** One prompt occurrence in an explore result (full text is fetched on demand). */
export interface ExploreRow {
	readonly id: string;
	readonly sessionKey: string;
	/** First ~240 characters. */
	readonly preview: string;
	/** Excerpt around the best match when it lies beyond the preview. */
	readonly snippet?: string;
	readonly timestamp: number;
	readonly origin: PromptOrigin;
	readonly length: number;
	/** Identical texts share a hash (forks, re-pasted prompts). */
	readonly hash: string;
	readonly isAck: boolean;
	readonly model?: string;
	readonly seq: number;
	/** Fused relevance (0 for browse queries). */
	readonly score: number;
	/** Best-chunk cosine similarity, when semantic retrieval ran. */
	readonly similarity?: number;
	readonly matchedLexical: boolean;
	readonly matchedSemantic: boolean;
	readonly matchRange?: readonly [start: number, end: number];
	/** Topic cluster id ({@link ExploreResult.topics}); -1 = small "Other" clusters; undefined = not clustered. */
	readonly topic?: number;
}

/** A cluster of similar prompts in an explore result. */
export interface Topic {
	readonly id: number;
	/** The first line of the topic's most central prompt (falls back to its keywords). */
	readonly label: string;
	/** Distinctive words, best first. */
	readonly terms: readonly string[];
	readonly size: number;
	/** Index (into the clustered set) of the most central prompt; informational. */
	readonly representative?: number;
}

export interface ExploreResult {
	readonly query: string;
	readonly freeText: string;
	readonly mode: SearchMode;
	readonly semanticUnavailable: boolean;
	/** Index revision the rows were computed from. */
	readonly revision: string;
	/** Every matching occurrence (all prompts for an empty query), best first. Facet filtering happens client-side. */
	readonly rows: readonly ExploreRow[];
	readonly sessions: Readonly<Record<string, SessionInfo>>;
	/** Topic clusters among the best results (empty when no embeddings are available). */
	readonly topics: readonly Topic[];
	readonly tookMs: number;
}

export interface IndexStatus {
	readonly indexPath: string;
	/** Size of the index database (including its write-ahead log). */
	readonly indexBytes: number;
	readonly sessions: number;
	readonly prompts: number;
	readonly promptsByOrigin: Readonly<Record<string, number>>;
	readonly promptsBySource: Readonly<Record<string, number>>;
	/** Chunks that should have embeddings (for the configured origins). */
	readonly chunks: number;
	readonly embeddedChunks: number;
	readonly pendingChunks: number;
	readonly embeddingPaused: boolean;
	readonly model?: string;
	readonly modelLoaded: boolean;
	readonly lastSyncAt?: number;
	readonly errors: readonly string[];
}

/** A session with its latest prompts, for the sidebar. */
export interface RecentSession {
	readonly session: SessionInfo;
	readonly promptCount: number;
	readonly lastActivity: number;
	readonly prompts: readonly { readonly id: string; readonly timestamp: number; readonly preview: string }[];
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

/** A way to reopen or resume the session a prompt came from. */
export interface SessionOpenTarget {
	readonly kind: 'agents-window' | 'chat-editor' | 'terminal-resume';
	readonly label: string;
	/** URI to open (deep link or chat-session resource). */
	readonly uri?: string;
	/** Shell command to resume the session in a terminal. */
	readonly command?: string;
	readonly cwd?: string;
	/** Chat-panel sessions can only be opened from a window on their own workspace. */
	readonly requiresWorkspace?: string;
	/** Best-effort targets may fail (e.g. the Agents window only lists external CLI sessions modified in the last 7 days). */
	readonly bestEffort?: boolean;
}

