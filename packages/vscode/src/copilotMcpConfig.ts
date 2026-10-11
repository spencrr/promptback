// Whether VS Code itself loads a server from Copilot CLI's MCP config. Kept free of `vscode` so it can be unit-tested.

/**
 * Whether VS Code reads Copilot CLI's `mcp-config.json`, given the default and effective values of
 * `chat.mcp.discovery.enabled`. Mirrors `isDiscoverySourceEnabled` (vscode `mcpConfiguration.ts`): a boolean applies
 * to every source, and an unset source uses its default. Builds whose default has no `copilot` source never read it.
 */
export function vscodeLoadsCopilotConfig(defaultValue: unknown, value: unknown): boolean {
	const byDefault = copilotEntry(defaultValue);
	if (typeof byDefault !== 'boolean') {
		return false;
	}
	if (typeof value === 'boolean') {
		return value;
	}
	const set = copilotEntry(value);
	return typeof set === 'boolean' ? set : byDefault;
}

/** Whether a Copilot CLI `mcp-config.json` defines a server with this (lowercase) name, ignoring case. */
export function definesServer(configText: string, name: string): boolean {
	try {
		const servers: unknown = (JSON.parse(configText) as { mcpServers?: unknown } | null)?.mcpServers;
		return !!servers && typeof servers === 'object' && Object.keys(servers).some(k => k.toLowerCase() === name);
	} catch {
		return false;
	}
}

function copilotEntry(value: unknown): unknown {
	return value && typeof value === 'object' ? (value as Record<string, unknown>)['copilot'] : undefined;
}
