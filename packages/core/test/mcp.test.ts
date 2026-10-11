import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptSearchEngine } from '../src/engine.js';
import { createMcpServer } from '../src/mcp.js';

let tmp: string;
let engine: PromptSearchEngine;
let client: Client;

function writeSession(home: string, id: string, yaml: string, events: { content: string; source?: string; id: string; ts: string }[]) {
	const dir = path.join(home, 'session-state', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml);
	fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify({
		type: 'user.message', id: e.id, timestamp: e.ts, data: { content: e.content, ...(e.source && { source: e.source }) },
	})).join('\n') + '\n');
}

async function call(name: string, args: Record<string, unknown> = {}) {
	const r = await client.callTool({ name, arguments: args });
	return { text: (r.content as { text: string }[])[0]!.text, isError: !!r.isError };
}

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yesterprompt-mcp-'));
	const home = path.join(tmp, 'copilot');
	writeSession(home, 'sess-alpha', 'id: sess-alpha\nrepository: owner/webapp\nbranch: main\ncwd: c:\\src\\webapp\nclient_name: github/cli\nname: Flaky tests\n', [
		{ content: 'Fix the flaky retry_policy test in the HTTP client', id: 'a1', ts: '2026-09-01T10:00:00.000Z' },
		{ content: 'Summarize the kusto incident results', source: 'agent-xyz', id: 'a2', ts: '2026-09-01T10:05:00.000Z' },
		{ content: `Now add a regression test. ${'More details. '.repeat(60)}`, id: 'a3', ts: '2026-09-01T10:10:00.000Z' },
	]);
	writeSession(home, 'sess-beta', 'id: sess-beta\nrepository: owner/docs\nclient_name: vscode-agent-host\nname: Design doc\n', [
		{ content: 'Write a design doc for the tree view', id: 'b1', ts: '2026-09-02T10:00:00.000Z' },
	]);
	engine = PromptSearchEngine.open({ indexDir: path.join(tmp, 'index'), copilotHome: home, vscodeRoots: null, embedding: { kind: 'none' } });
	await engine.sync();
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(engine, { version: 'test' }).connect(serverSide);
	client = new Client({ name: 'test', version: '0' });
	await client.connect(clientSide);
});

afterEach(async () => {
	await client.close();
	await engine.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MCP server', () => {
	it('offers five read-only tools and usage instructions', async () => {
		const { tools } = await client.listTools();
		expect(tools.map(t => t.name).sort()).toEqual(['get_prompt', 'get_session', 'index_status', 'list_recent_sessions', 'search_prompts']);
		expect(tools.every(t => t.annotations?.readOnlyHint === true && t.annotations.openWorldHint === false)).toBe(true);
		expect(client.getInstructions()).toContain('search_prompts');
	});

	it('finds a prompt, then follows its ids to the full prompt and the session', async () => {
		const found = await call('search_prompts', { query: 'retry_policy' });
		expect(found.text).toContain('Fix the flaky retry_policy test');
		expect(found.text).toContain('owner/webapp · main · Copilot CLI');

		const prompt = await call('get_prompt', { id: /prompt: (\S+)/.exec(found.text)![1]! });
		expect(prompt.text).toContain('by the user');
		expect(prompt.text).toContain('copilot --resume sess-alpha');
		expect(prompt.text.endsWith('Fix the flaky retry_policy test in the HTTP client')).toBe(true);

		const session = await call('get_session', { session_id: /session: (\S+)/.exec(found.text)![1]! });
		expect(session.text).toContain('2 prompts from');
		expect(session.text).not.toContain('kusto');
		expect(session.text).toContain('truncated, full text: get_prompt copilot:sess-alpha:a3');
	});

	it('includes injected messages on request and accepts a unique id prefix', async () => {
		const session = await call('get_session', { session_id: 'sess-al', include_all_authors: true });
		expect(session.text).toContain('3 messages');
		expect(session.text).toContain('from an agent');
	});

	it('reports unknown and ambiguous ids as tool errors', async () => {
		expect(await call('get_prompt', { id: 'copilot:nope:x' })).toMatchObject({ isError: true });
		expect(await call('get_session', { session_id: 'zzz' })).toMatchObject({ isError: true });
		const ambiguous = await call('get_session', { session_id: 'sess-' });
		expect(ambiguous.isError).toBe(true);
		expect(ambiguous.text).toContain('2 sessions match');
	});

	it('lists recent sessions newest first and reports index status', async () => {
		const recent = await call('list_recent_sessions');
		expect(recent.text.indexOf('Design doc')).toBeGreaterThan(-1);
		expect(recent.text.indexOf('Design doc')).toBeLessThan(recent.text.indexOf('Flaky tests'));
		expect((await call('index_status')).text).toContain('Prompts: 4 in 2 sessions');
	});
});
