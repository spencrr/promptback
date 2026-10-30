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

function writeSession(
	home: string,
	id: string,
	yaml: string,
	events: { content: string; source?: string; id: string; ts: string }[],
) {
	const dir = path.join(home, 'session-state', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml);
	fs.writeFileSync(
		path.join(dir, 'events.jsonl'),
		`${events
			.map(e =>
				JSON.stringify({
					type: 'user.message',
					id: e.id,
					timestamp: e.ts,
					data: { content: e.content, ...(e.source && { source: e.source }) },
				}),
			)
			.join('\n')}\n`,
	);
}

async function call(name: string, args: Record<string, unknown> = {}) {
	const r = await client.callTool({ name, arguments: args });
	return {
		text: (r.content as { text: string }[])[0]!.text,
		isError: Boolean(r.isError),
		structuredContent: r.structuredContent,
	};
}

beforeEach(async () => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-mcp-'));
	const home = path.join(tmp, 'copilot');
	writeSession(
		home,
		'sess-alpha',
		'id: sess-alpha\nrepository: owner/webapp\nbranch: main\ncwd: c:\\src\\webapp\nclient_name: github/cli\nname: Flaky tests\n',
		[
			{ content: 'Fix the flaky retry_policy test in the HTTP client', id: 'a1', ts: '2026-09-01T10:00:00.000Z' },
			{
				content: 'Summarize the kusto incident results',
				source: 'agent-xyz',
				id: 'a2',
				ts: '2026-09-01T10:05:00.000Z',
			},
			{
				content: `Now add a regression test. ${'More details. '.repeat(60)}`,
				id: 'a3',
				ts: '2026-09-01T10:10:00.000Z',
			},
		],
	);
	writeSession(
		home,
		'sess-beta',
		'id: sess-beta\nrepository: owner/docs\nclient_name: vscode-agent-host\nname: Design doc\n',
		[{ content: 'Write a design doc for the tree view', id: 'b1', ts: '2026-09-02T10:00:00.000Z' }],
	);
	engine = PromptSearchEngine.open({
		indexDir: path.join(tmp, 'index'),
		sources: {
			copilot: { home },
			'vscode-chat': { enabled: false },
			'agent-host': { enabled: false },
			'claude-code': { enabled: false },
			codex: { enabled: false },
		},
		embedding: { kind: 'none' },
	});
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
	it('offers read-only tools and usage instructions', async () => {
		const { tools } = await client.listTools();
		expect(tools.map(t => t.name).sort()).toEqual([
			'explore_prompts',
			'get_prompt',
			'get_session',
			'index_status',
			'list_recent_sessions',
			'search_prompts',
		]);
		expect(tools.every(t => t.annotations?.readOnlyHint === true && t.annotations.openWorldHint === false)).toBe(
			true,
		);
		expect(client.getInstructions()).toContain('search_prompts');
	});

	it('declares the results app on search_prompts and keeps its structured twin app-only', async () => {
		const { tools } = await client.listTools();
		const search = tools.find(t => t.name === 'search_prompts')!;
		const explore = tools.find(t => t.name === 'explore_prompts')!;
		// The app is attached to the tool the model calls; the text result is what it has always been.
		expect(search._meta).toEqual({ ui: { resourceUri: 'ui://promptback/search.html' } });
		const found = await call('search_prompts', { query: 'retry_policy' });
		expect(found.structuredContent).toBeUndefined();
		// Structured results come from the twin, which hosts honouring `visibility` hide from the model.
		expect(explore._meta).toEqual({ ui: { visibility: ['app'] } });
		const structured = await client.callTool({ name: 'explore_prompts', arguments: { query: 'retry_policy' } });
		const data = structured.structuredContent as {
			hits: { id: string; preview: string; session: { open: unknown[] } }[];
		};
		expect(data.hits).toHaveLength(1);
		expect(data.hits[0]!.preview).toContain('retry_policy');
		expect(data.hits[0]!.session.open.length).toBeGreaterThan(0);
		// The app itself is a self-contained HTML resource of the MCP Apps profile.
		const { resources } = await client.listResources();
		expect(resources.map(r => r.uri)).toEqual(['ui://promptback/search.html']);
		const html = await client.readResource({ uri: 'ui://promptback/search.html' });
		const page = html.contents[0]!;
		expect(page.mimeType).toBe('text/html;profile=mcp-app');
		expect('text' in page && page.text).toMatch(/^<!doctype html>/iu);
	});

	it('can run without the app, exactly as before', async () => {
		const [c, s] = InMemoryTransport.createLinkedPair();
		await createMcpServer(engine, { version: 'test', app: false }).connect(s);
		const plain = new Client({ name: 'plain', version: '0' });
		await plain.connect(c);
		const { tools } = await plain.listTools();
		expect(tools.map(t => t.name)).not.toContain('explore_prompts');
		expect(tools.find(t => t.name === 'search_prompts')!._meta).toBeUndefined();
		expect(plain.getServerCapabilities()?.resources).toBeUndefined();
		await plain.close();
	});

	it('finds a prompt, then follows its ids to the full prompt and the session', async () => {
		const found = await call('search_prompts', { query: 'retry_policy' });
		expect(found.text).toContain('Fix the flaky retry_policy test');
		expect(found.text).toContain('owner/webapp · main · Copilot CLI');
		// Embeddings are off in this index; the model reading the result is told so, not left guessing.
		expect(found.text).toMatch(
			/^1 prompt for "retry_policy", best first \(keyword matches only; semantic search is turned off\):/u,
		);

		const prompt = await call('get_prompt', { id: /prompt: (\S+)/u.exec(found.text)![1]! });
		expect(prompt.text).toContain('by the user');
		expect(prompt.text).toContain('copilot --resume sess-alpha');
		expect(prompt.text.endsWith('Fix the flaky retry_policy test in the HTTP client')).toBe(true);

		const session = await call('get_session', { session_id: /session: (\S+)/u.exec(found.text)![1]! });
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
		const status = (await call('index_status')).text;
		expect(status).toContain('Prompts: 4 in 2 sessions');
		expect(status).toContain('Semantic search: off;');
	});
});
