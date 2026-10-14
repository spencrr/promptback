import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptSearchEngine } from '../src/engine.js';
import { sessionOpenTargets } from '../src/links.js';
import { classifyCodexOrigin, listCodexSessionFiles, readCodexSession } from '../src/sources/codex.js';

let tmp: string;
let home: string;

const TID = '01a0b10c-5497-7cc1-bb25-5e7f6293f5d2';

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ timestamp, type, payload });
}

function userItem(timestamp: string, text: string, id?: string): string {
	return line(timestamp, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }], ...(id ? { id } : {}) });
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-codex-'));
	home = path.join(tmp, '.codex');
	const day = path.join(home, 'sessions', '2026', '09', '17');
	fs.mkdirSync(day, { recursive: true });
	fs.writeFileSync(
		path.join(day, `rollout-2026-09-17T13-26-10-${TID}.jsonl`),
		[
			line('2026-09-17T20:26:11.000Z', 'session_meta', {
				id: TID,
				timestamp: '2026-09-17T20:26:10.000Z',
				cwd: 'c:\\src\\PyRIT',
				originator: 'codex_cli_rs',
				cli_version: '0.153.0',
				source: 'cli',
				git: { branch: 'feature/x', commit_hash: 'abc', repository_url: 'https://github.com/owner/PyRIT.git' },
			}),
			line('2026-09-17T20:26:11.000Z', 'turn_context', { model: 'gpt-6-astra', cwd: 'c:\\src\\PyRIT' }),
			userItem('2026-09-17T20:26:12.000Z', '<environment_context>\n  <cwd>c:\\src\\PyRIT</cwd>\n</environment_context>', 'msg_env'),
			userItem('2026-09-17T20:26:12.000Z', 'Implement strict lockstep compatibility for the converters', 'msg_1'),
			line('2026-09-17T20:26:20.000Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] }),
			line('2026-09-17T20:26:21.000Z', 'response_item', { type: 'function_call', name: 'shell', arguments: '{}' }),
			userItem('2026-09-17T20:40:00.000Z', '<turn_aborted>\nThe user interrupted.\n</turn_aborted>'),
			line('2026-09-17T20:41:00.000Z', 'turn_context', { model: 'gpt-6-sol' }),
			userItem('2026-09-17T20:41:01.000Z', 'Now write the tests', 'msg_2'),
			'',
		].join('\n'),
	);
	// An archived sub-agent thread: its prompts come from the parent agent.
	const archived = path.join(home, 'archived_sessions', '2026', '09', '18');
	fs.mkdirSync(archived, { recursive: true });
	fs.writeFileSync(
		path.join(archived, 'rollout-2026-09-18T01-00-00-11111111-2222-7333-8444-555555555555.jsonl'),
		[
			line('2026-09-18T01:00:00.000Z', 'session_meta', { id: '11111111-2222-7333-8444-555555555555', cwd: 'c:\\src\\PyRIT', originator: 'vscode_agent_host', source: { subagent: 'thread_spawn' } }),
			userItem('2026-09-18T01:00:01.000Z', 'Review the converter module for races'),
			'',
		].join('\n'),
	);
	// Pre-response_item format: prompts only as events.
	fs.writeFileSync(
		path.join(day, 'rollout-2026-09-17T09-00-00-aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl'),
		[
			line('2026-09-17T09:00:00.000Z', 'session_meta', { id: 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', cwd: 'c:\\src\\other', originator: 'codex_exec' }),
			line('2026-09-17T09:00:01.000Z', 'event_msg', { type: 'user_message', message: 'Run the migration script' }),
			'',
		].join('\n'),
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Codex source', () => {
	it('lists rollouts under sessions and archived_sessions', () => {
		expect(listCodexSessionFiles(home).map(f => f.sessionId).sort()).toEqual([
			TID,
			'11111111-2222-7333-8444-555555555555',
			'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
		]);
	});

	it('projects user response items to prompts with the model of their turn and the repository from git metadata', () => {
		const file = listCodexSessionFiles(home).find(f => f.sessionId === TID)!;
		const r = readCodexSession(file, fs.statSync(file.path).size);
		expect(r.error).toBeUndefined();
		expect(r.prompts.map(p => [p.id.split(':').at(-1), p.origin, p.model])).toEqual([
			['msg_env', 'system', 'gpt-6-astra'],
			['msg_1', 'human', 'gpt-6-astra'],
			['#3', 'system', 'gpt-6-astra'],
			['msg_2', 'human', 'gpt-6-sol'],
		]);
		expect(r.session).toMatchObject({
			key: `codex:${TID}`,
			source: 'codex',
			title: 'Implement strict lockstep compatibility for the converters',
			cwd: 'c:\\src\\PyRIT',
			repository: 'owner/PyRIT',
			branch: 'feature/x',
			client: 'codex/cli',
			createdAt: Date.parse('2026-09-17T20:26:10.000Z'),
			updatedAt: Date.parse('2026-09-17T20:41:01.000Z'),
		});
	});

	it('treats sub-agent threads as agent prompts and reads event-only rollouts', () => {
		const files = listCodexSessionFiles(home);
		const sub = readCodexSession(files.find(f => f.sessionId.startsWith('1111'))!, 10_000);
		expect(sub.prompts.map(p => p.origin)).toEqual(['agent']);
		expect(sub.session.client).toBe('codex/vscode');
		const old = readCodexSession(files.find(f => f.sessionId.startsWith('aaaa'))!, 10_000);
		expect(old.prompts.map(p => [p.text, p.origin])).toEqual([['Run the migration script', 'human']]);
		expect(old.session.client).toBe('codex/exec');
	});

	it('classifies injected context', () => {
		expect(classifyCodexOrigin('Fix it', false)).toBe('human');
		expect(classifyCodexOrigin('<environment_context>x</environment_context>', false)).toBe('system');
		expect(classifyCodexOrigin('<subagent_notification>x</subagent_notification>', false)).toBe('system');
		expect(classifyCodexOrigin('Fix it', true)).toBe('agent');
	});

	it('indexes through the engine with source and client filters and a resume command', async () => {
		const engine = PromptSearchEngine.open({
			indexDir: path.join(tmp, 'index'),
			sources: {
				copilot: { enabled: false },
				'vscode-chat': { enabled: false },
				'agent-host': { enabled: false },
				'claude-code': { enabled: false },
				codex: { home },
			},
			embedding: { kind: 'none' },
		});
		try {
			const r = await engine.sync();
			expect(r.errors).toEqual([]);
			expect(r.addedPrompts).toBe(6);
			const hits = (await engine.search('lockstep src:codex')).hits;
			expect(hits).toHaveLength(1);
			expect((await engine.search('lockstep client:codex repo:PyRIT')).hits).toHaveLength(1);
			// The sub-agent thread's prompt is an agent message: hidden by default, searchable with from:agent.
			expect((await engine.search('races')).hits).toHaveLength(0);
			expect((await engine.search('races from:agent')).hits.map(h => h.session.client)).toEqual(['codex/vscode']);
			expect(sessionOpenTargets(hits[0]!.session)).toEqual([
				{ kind: 'terminal-resume', label: 'Resume with Codex', command: `codex resume ${TID}`, cwd: 'c:\\src\\PyRIT' },
			]);
		} finally {
			await engine.close();
		}
	});
});
