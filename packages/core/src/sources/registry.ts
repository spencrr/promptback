import { Registry } from '../registry.js';
import type { ClientInfo, SourceCatalog } from '../types.js';
import { agentHostSource } from './agentHostSource.js';
import type { PromptSourcePlugin } from './base.js';
import { claudeCodeSource } from './claudeCode.js';
import { codexSource } from './codex.js';
import { copilotSource } from './copilotSource.js';
import { vscodeChatSource } from './vscodeChatSource.js';

export type { PromptSourcePlugin, SourceContext, SourceStore, SourceSyncResult } from './base.js';
export { baseSourceOptions } from './base.js';

/**
 * The prompt sources an engine syncs, in registration order. Register another plugin before opening an engine to
 * add a source; its options are validated by its own schema and saved in the index like everyone else's.
 */
export const promptSources = new Registry<PromptSourcePlugin>('prompt source', [
	copilotSource,
	vscodeChatSource,
	agentHostSource,
	claudeCodeSource,
	codexSource,
]);

/** Labels and clients of every registered source, for UIs that cannot import the plugins (the webview). */
export function sourceCatalog(registry: Registry<PromptSourcePlugin> = promptSources): SourceCatalog {
	const clients: Record<string, ClientInfo> = {};
	const sources = registry.list().map(s => {
		for (const c of s.clients) {
			clients[c.id] = c;
		}
		return { id: s.id, label: s.label, description: s.description, aliases: s.aliases, clients: s.clients };
	});
	return { sources, clients };
}

/** `src:` operator values → source id, and `client:` operator values → client id, from the registry. */
export function sourceAliases(registry: Registry<PromptSourcePlugin> = promptSources): {
	readonly sources: ReadonlyMap<string, string>;
	readonly clients: ReadonlyMap<string, string>;
} {
	const sources = new Map<string, string>();
	const clients = new Map<string, string>();
	for (const s of registry.list()) {
		sources.set(s.id, s.id);
		for (const a of s.aliases) {
			sources.set(a.toLowerCase(), s.id);
		}
		for (const c of s.clients) {
			clients.set(c.id.toLowerCase(), c.id);
			for (const a of c.aliases) {
				clients.set(a.toLowerCase(), c.id);
			}
		}
	}
	return { sources, clients };
}

/** Label of a client id for prose (MCP results, CLI output); falls back to the id. */
export function clientLabel(id: string | undefined, registry: Registry<PromptSourcePlugin> = promptSources): string {
	if (!id) {
		return 'unknown client';
	}
	for (const s of registry.list()) {
		const client = s.clients.find(c => c.id === id);
		if (client) {
			return client.label;
		}
	}
	return id;
}
