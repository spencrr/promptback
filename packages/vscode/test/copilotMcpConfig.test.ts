import { describe, expect, it } from 'vitest';
import { definesServer, vscodeLoadsCopilotConfig } from '../src/copilotMcpConfig.js';

// Defaults of `chat.mcp.discovery.enabled` with and without the Copilot CLI source.
const withCopilot = { 'claude-desktop': false, copilot: true, windsurf: false, 'cursor-global': false, 'cursor-workspace': false };
const withoutCopilot = { 'claude-desktop': false, windsurf: false, 'cursor-global': false, 'cursor-workspace': false };

describe('vscodeLoadsCopilotConfig', () => {
	it('follows chat.mcp.discovery.enabled the way VS Code does', () => {
		expect(vscodeLoadsCopilotConfig(withCopilot, withCopilot)).toBe(true);
		expect(vscodeLoadsCopilotConfig(withCopilot, { windsurf: true })).toBe(true);
		expect(vscodeLoadsCopilotConfig(withCopilot, { ...withCopilot, copilot: false })).toBe(false);
		expect(vscodeLoadsCopilotConfig(withCopilot, false)).toBe(false);
		expect(vscodeLoadsCopilotConfig(withCopilot, true)).toBe(true);
	});

	it('is false on VS Code builds without the Copilot CLI discovery source', () => {
		expect(vscodeLoadsCopilotConfig(withoutCopilot, withoutCopilot)).toBe(false);
		expect(vscodeLoadsCopilotConfig(withoutCopilot, true)).toBe(false);
		expect(vscodeLoadsCopilotConfig(undefined, undefined)).toBe(false);
	});
});

describe('definesServer', () => {
	it('matches the server name ignoring case and tolerates unreadable files', () => {
		expect(definesServer('{"mcpServers":{"Yesterprompt":{"command":"yester"}}}', 'yesterprompt')).toBe(true);
		expect(definesServer('{"mcpServers":{"playwright":{"command":"npx"}}}', 'yesterprompt')).toBe(false);
		expect(definesServer('{"mcpServers":', 'yesterprompt')).toBe(false);
		expect(definesServer('null', 'yesterprompt')).toBe(false);
	});
});
