import * as z from 'zod/v4';
import type { ConfigurablePlugin } from '../registry.js';
import type { Chunk } from '../search/chunk.js';
import type { ClientInfo, PromptRecord, SessionInfo, SessionOpenTarget } from '../types.js';

/** The slice of the index a source may touch. Sources only ever read their inputs; this is where they write. */
export interface SourceStore {
	transaction<T>(fn: () => T): T;
	/** Every saved read cursor of one kind (one query per sync). */
	loadFileStates<T>(kind: string): Map<string, T>;
	setFileState(file: string, kind: string, state: unknown): void;
	deleteFile(file: string): void;
	upsertSession(session: SessionInfo): void;
	/** Removes a session and its prompts; returns how many prompts went. */
	deleteSession(key: string): number;
	/** Inserts prompts whose ids are new; returns how many were inserted. */
	insertPrompts(prompts: readonly PromptRecord[], chunker: (text: string) => Chunk[]): number;
	/** Makes a session's prompts exactly `prompts`; returns [added, removed]. */
	replaceSessionPrompts(sessionKey: string, prompts: readonly PromptRecord[], chunker: (text: string) => Chunk[]): [number, number];
	replaceAgentHostLinks(
		links: readonly { sdkSessionId: string; agentHostSessionId: string; product: string; chatId?: string; title?: string }[],
	): void;
}

/** What the engine hands a source for one sync. */
export interface SourceContext {
	readonly store: SourceStore;
	readonly chunker: (text: string) => Chunk[];
	/** Keep prompts whose session file disappeared from disk. */
	readonly retainDeleted: boolean;
	/** Set when the engine is closing; stop at the next convenient point. */
	readonly signal: AbortSignal;
	readonly log: (message: string) => void;
	/** Call between files so a long scan does not starve the process. */
	readonly yieldToLoop: () => Promise<void>;
}

export interface SourceSyncResult {
	readonly added: number;
	readonly removed: number;
	/** Session metadata (titles, repositories, links) changed even if no prompt did. */
	readonly sessionsChanged: boolean;
	/** Per-file problems; the sync goes on. */
	readonly errors: readonly string[];
}

/**
 * A reader of one kind of prompt history. `sync` is incremental and idempotent: it compares what is on disk with the
 * cursors it saved in {@link SourceStore.loadFileStates} and writes only the difference. A source may also produce no
 * prompts and only enrich sessions (the Agents-window link source does).
 */
export interface PromptSourcePlugin<O = unknown> extends ConfigurablePlugin<O> {
	readonly label: string;
	readonly description: string;
	/** Words accepted by the `src:` query operator besides the id. */
	readonly aliases: readonly string[];
	/** The clients whose sessions this source reads ({@link SessionInfo.client} values). */
	readonly clients: readonly ClientInfo[];
	sync(options: O, ctx: SourceContext): Promise<SourceSyncResult>;
	/** Ways to reopen a session this source read, best first. */
	openTargets?(session: SessionInfo): SessionOpenTarget[];
}

/** Options every source has; plugins extend this schema. */
export const baseSourceOptions = z.object({
	enabled: z.boolean().default(true),
});

export type BaseSourceOptions = z.infer<typeof baseSourceOptions>;
