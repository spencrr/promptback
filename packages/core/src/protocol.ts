import type { EngineOptions } from './engine.js';
import type { IndexStatus, PromptRecord, SearchQuery, SearchResult, SessionInfo, SyncProgress, SyncResult } from './types.js';

/** Serializable subset of {@link EngineOptions} plus host scheduling. */
export interface HostInitOptions extends Omit<EngineOptions, 'log'> {
	/** Background re-scan interval (ms); 0 disables. */
	readonly syncIntervalMs?: number;
	/** Unload the embedding model after this long without use (ms); 0 disables. */
	readonly idleReleaseMs?: number;
}

export interface HostMethods {
	init(opts: HostInitOptions): { indexDir: string };
	search(q: SearchQuery): SearchResult;
	getPrompt(id: string): { prompt: PromptRecord; session?: SessionInfo } | undefined;
	getSessionPrompts(sessionKey: string): PromptRecord[];
	status(): IndexStatus & { syncing: boolean };
	/** Triggers a sync; resolves when it finishes. */
	sync(opts: { embed?: boolean }): SyncResult;
	/** Cheap: syncs only if the last sync is older than `maxAgeMs`. */
	touch(opts: { maxAgeMs: number }): void;
}

export type HostRequest = { [M in keyof HostMethods]: { type: 'req'; id: number; method: M; params: Parameters<HostMethods[M]>[0] } }[keyof HostMethods];

export type HostResponse =
	| { type: 'res'; id: number; result: unknown }
	| { type: 'res'; id: number; error: string };

export type HostEvent =
	| { type: 'event'; name: 'progress'; data: SyncProgress }
	| { type: 'event'; name: 'synced'; data: SyncResult }
	| { type: 'event'; name: 'log'; data: string };
