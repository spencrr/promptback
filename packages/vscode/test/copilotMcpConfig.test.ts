import { describe, expect, it } from 'vitest';
import { definesServer } from '../src/copilotMcpConfig.js';

describe('definesServer', () => {
	it('matches the server name ignoring case and tolerates unreadable files', () => {
		expect(definesServer('{"mcpServers":{"Yesterprompt":{"command":"yester"}}}', 'yesterprompt')).toBe(true);
		expect(definesServer('{"mcpServers":{"playwright":{"command":"npx"}}}', 'yesterprompt')).toBe(false);
		expect(definesServer('{"mcpServers":', 'yesterprompt')).toBe(false);
		expect(definesServer('null', 'yesterprompt')).toBe(false);
	});
});
