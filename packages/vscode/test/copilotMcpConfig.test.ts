import { describe, expect, it } from 'vitest';
import { definesServer } from '../src/copilotMcpConfig.js';

describe('definesServer', () => {
	it('matches the server name ignoring case and tolerates unreadable files', () => {
		expect(definesServer('{"mcpServers":{"Promptback":{"command":"promptback"}}}', 'promptback')).toBe(true);
		expect(definesServer('{"mcpServers":{"playwright":{"command":"npx"}}}', 'promptback')).toBe(false);
		expect(definesServer('{"mcpServers":', 'promptback')).toBe(false);
		expect(definesServer('null', 'promptback')).toBe(false);
	});
});
