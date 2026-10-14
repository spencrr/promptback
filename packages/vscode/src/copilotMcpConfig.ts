// Reads Copilot CLI's MCP config. Kept free of `vscode` so it can be unit-tested.

/** Whether a Copilot CLI `mcp-config.json` defines a server with this (lowercase) name, ignoring case. */
export function definesServer(configText: string, name: string): boolean {
	try {
		const servers: unknown = (JSON.parse(configText) as { mcpServers?: unknown } | null)?.mcpServers;
		return (
			typeof servers === 'object' && servers !== null && Object.keys(servers).some(k => k.toLowerCase() === name)
		);
	} catch {
		return false;
	}
}
