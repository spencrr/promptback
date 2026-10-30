/**
 * End-to-end through the real CLI entry: builds dist/cli.js, then runs it as a child process against fixture
 * histories in a temp folder (never this machine's). Covers index → search → get → status → sources, the cache hit
 * on re-index, and the MCP server over real stdio.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const pkgDir = path.resolve(import.meta.dirname, '..');
const cliJs = path.join(pkgDir, 'dist', 'cli.js');

let tmp: string;
let env: NodeJS.ProcessEnv;

function writeCopilotSession(
	home: string,
	id: string,
	yaml: string,
	prompts: { id: string; text: string; ts: string; source?: string }[],
) {
	const dir = path.join(home, 'session-state', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml);
	const lines = prompts.map(p =>
		JSON.stringify({
			type: 'user.message',
			id: p.id,
			timestamp: p.ts,
			data: { content: p.text, ...(p.source ? { source: p.source } : {}) },
		}),
	);
	fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
}

function writeClaudeSession(home: string, sessionId: string, prompts: { uuid: string; text: string; ts: string }[]) {
	const dir = path.join(home, 'projects', 'C--src-webapp');
	fs.mkdirSync(dir, { recursive: true });
	const lines = prompts.map(p =>
		JSON.stringify({
			type: 'user',
			uuid: p.uuid,
			timestamp: p.ts,
			sessionId,
			cwd: 'C:\\src\\webapp',
			entrypoint: 'cli',
			message: { role: 'user', content: p.text },
		}),
	);
	fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

function cli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
	return run(process.execPath, [cliJs, ...args], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

beforeAll(async () => {
	await run(process.execPath, [path.join(pkgDir, 'scripts', 'build.mjs')], { cwd: pkgDir });
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-e2e-'));
	const copilotHome = path.join(tmp, 'copilot');
	const claudeHome = path.join(tmp, 'claude');
	writeCopilotSession(
		copilotHome,
		'sess-1',
		'id: sess-1\nrepository: owner/webapp\nclient_name: github/cli\nname: Flaky tests\n',
		[
			{ id: 'a1', text: 'Fix the flaky retry_policy test in the HTTP client', ts: '2026-09-01T10:00:00.000Z' },
			{ id: 'a2', text: 'Summarize the incident', ts: '2026-09-01T10:05:00.000Z', source: 'agent-x' },
		],
	);
	writeClaudeSession(claudeHome, '11111111-2222-4333-8444-555555555555', [
		{ uuid: 'u1', text: 'Write a design doc for the tree view', ts: '2026-09-02T10:00:00.000Z' },
	]);
	fs.mkdirSync(path.join(tmp, 'codex'), { recursive: true });
	// Every default location points into the temp folder, so nothing on this machine is read.
	env = {
		...process.env,
		PROMPTBACK_HOME: path.join(tmp, 'index'),
		COPILOT_HOME: copilotHome,
		CLAUDE_CONFIG_DIR: claudeHome,
		CODEX_HOME: path.join(tmp, 'codex'),
		HOME: tmp,
		USERPROFILE: tmp,
		APPDATA: path.join(tmp, 'appdata'),
		XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
	};
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('promptback CLI (built binary)', () => {
	it('prints its version and help', async () => {
		const version = (await cli('--version')).stdout.trim();
		expect(version).toBe(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version);
		expect((await cli('--help')).stdout).toMatch(/^promptback \d+\.\d+\.\d+ — semantic search/u);
	});

	it('indexes fixture sources, searches, fetches a prompt, and reports status and sources', async () => {
		const index = await cli('index', '--no-model');
		expect(index.stdout.trim()).toMatch(/^\+3 \/ -0 prompts, 0 chunks embedded, 0 pending, 0 errors/u);

		const search = JSON.parse((await cli('search', 'flaky retry', '--json', '--no-model')).stdout) as {
			hits: { prompt: { id: string; text: string }; session: { client: string } }[];
			semanticUnavailable: boolean;
			semantic: { state: string };
		};
		expect(search.semanticUnavailable).toBe(true);
		expect(search.semantic).toEqual({ state: 'off' });
		expect(search.hits).toHaveLength(1);
		expect(search.hits[0]!.session.client).toBe('github/cli');

		const human = await cli('search', 'tree view', '--no-model');
		expect(human.stdout).toMatch(/1\. Write a design doc for the tree view/u);
		expect(human.stdout).toMatch(/resume: claude --resume 11111111-2222-4333-8444-555555555555/u);
		expect(human.stderr).toMatch(/1 hits in \d+ ms/u);

		const got = await cli('get', search.hits[0]!.prompt.id, '--no-model');
		expect(got.stdout.trim()).toBe('Fix the flaky retry_policy test in the HTTP client');

		const status = JSON.parse((await cli('status', '--json', '--no-model')).stdout) as {
			prompts: number;
			promptsBySource: Record<string, number>;
		};
		expect(status.prompts).toBe(3);
		expect(status.promptsBySource).toEqual({ copilot: 2, 'claude-code': 1 });

		const sources = (await cli('sources', '--no-model')).stdout;
		expect(sources).toMatch(/^on\s+copilot\s+Copilot sessions/mu);
		expect(sources).toMatch(/^on\s+codex\s+Codex/mu);

		// Re-indexing unchanged history is a cache hit: nothing is re-read or re-added.
		const again = await cli('index', '--no-model');
		expect(again.stdout.trim()).toMatch(/^\+0 \/ -0 prompts/u);
	});

	it('doctor reports the semantic-search state and exits 1 when it is unavailable', async () => {
		const off = await cli('doctor', '--no-model');
		expect(off.stdout).toMatch(/^platform\s+(win32|linux|darwin)-\w+, Node v\d+/mu);
		expect(off.stdout).toMatch(/^sources\s+copilot on, /mu);
		expect(off.stdout).toMatch(/^semantic\s+off \(--no-model\)/mu);

		// No model in the temp home and downloads off: the real runtime is probed, then the model is reported missing.
		await expect(cli('doctor', '--no-download')).rejects.toMatchObject({
			code: 1,
			stdout: expect.stringMatching(/^semantic\s+UNAVAILABLE: .*(downloads are disabled|no build for)/mu),
		});
		const human = await cli('search', 'tree view', '--no-download');
		expect(human.stderr).toMatch(/^\(keyword matches only; semantic search unavailable: .*\.\)$/mu);
		expect(human.stdout).toMatch(/1\. Write a design doc for the tree view/u);
	});

	it('fails clearly on an unknown command and a missing prompt', async () => {
		await expect(cli('frobnicate')).rejects.toMatchObject({ code: 2 });
		await expect(cli('get', 'nope', '--no-model')).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('Not found'),
		});
	});

	it('serves the MCP tools over stdio, keeping stdout clean for the protocol', async () => {
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [cliJs, 'mcp', '--no-model'],
			env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string')),
			stderr: 'pipe',
		});
		const client = new Client({ name: 'e2e', version: '0' });
		await client.connect(transport);
		try {
			const tools = (await client.listTools()).tools.map(t => t.name).sort((a, b) => a.localeCompare(b));
			expect(tools).toEqual([
				'get_prompt',
				'get_session',
				'index_status',
				'list_recent_sessions',
				'search_prompts',
			]);
			const result = await client.callTool({ name: 'search_prompts', arguments: { query: 'retry_policy' } });
			const text = (result.content as { type: string; text: string }[])[0]!.text;
			expect(text).toMatch(/1 prompt for "retry_policy"/u);
			expect(text).toMatch(/copilot:sess-1:a1/u);
			const status = await client.callTool({ name: 'index_status', arguments: {} });
			expect((status.content as { text: string }[])[0]!.text).toMatch(/Prompts: 3 in 2 sessions/u);
		} finally {
			await client.close();
		}
	});
});
