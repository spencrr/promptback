import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCopilotOrigin, listCopilotSessions, readCopilotEvents, readCopilotSessionInfo } from '../src/sources/copilot.js';

let home: string;
const SID = '11111111-2222-3333-4444-555555555555';

function ev(type: string, data: Record<string, unknown>, id: string, ts = '2026-09-01T10:00:00.000Z') {
	return JSON.stringify({ type, data, id, timestamp: ts, parentId: null }) + '\n';
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-copilot-'));
	fs.mkdirSync(path.join(home, 'session-state', SID), { recursive: true });
	fs.mkdirSync(path.join(home, 'session-state', '.session-operation-locks'), { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const eventsPath = () => path.join(home, 'session-state', SID, 'events.jsonl');

describe('copilot events source', () => {
	it('lists session directories and skips dot-folders', () => {
		expect(listCopilotSessions(home).map(s => s.sessionId)).toEqual([SID]);
	});

	it('reads user messages incrementally, skipping huge unrelated lines and blanks', () => {
		const big = 'x'.repeat(3 * 1024 * 1024);
		fs.writeFileSync(eventsPath(),
			ev('session.start', { selectedModel: 'model-a', startTime: '2026-09-01T09:00:00.000Z', context: { cwd: 'C:\\src\\repo' } }, 'e0')
			+ ev('user.message', { content: 'hello world' }, 'e1')
			+ ev('tool.execution_complete', { output: big }, 'e2')
			+ ev('user.message', { content: '   ' }, 'e3')
			+ ev('session.model_change', { newModel: 'model-b' }, 'e4')
			+ ev('user.message', { content: 'from agent', source: 'agent-abc' }, 'e5'));
		const [s] = listCopilotSessions(home);
		const r1 = readCopilotEvents(s!, undefined)!;
		expect(r1.reset).toBe(true);
		expect(r1.prompts.map(p => [p.text, p.origin, p.model, p.seq])).toEqual([
			['hello world', 'human', 'model-a', 0],
			['from agent', 'agent', 'model-b', 1],
		]);
		expect(r1.prompts[0]!.id).toBe(`copilot:${SID}:e1`);
		expect(r1.state.cwd).toBe('C:\\src\\repo');

		expect(readCopilotEvents(s!, r1.state)).toBeUndefined();

		fs.appendFileSync(eventsPath(), ev('user.message', { content: 'second' }, 'e6'));
		const r2 = readCopilotEvents(s!, r1.state)!;
		expect(r2.reset).toBe(false);
		expect(r2.prompts.map(p => [p.text, p.seq])).toEqual([['second', 2]]);
	});

	it('waits for an incomplete trailing line, then picks it up', () => {
		const line = ev('user.message', { content: 'partial' }, 'p1');
		fs.writeFileSync(eventsPath(), ev('user.message', { content: 'one' }, 'o1') + line.slice(0, 20));
		const [s] = listCopilotSessions(home);
		const r1 = readCopilotEvents(s!, undefined)!;
		expect(r1.prompts.map(p => p.text)).toEqual(['one']);
		fs.appendFileSync(eventsPath(), line.slice(20));
		const r2 = readCopilotEvents(s!, r1.state)!;
		expect(r2.prompts.map(p => p.text)).toEqual(['partial']);
	});

	it('re-reads from scratch when the file is rewritten', () => {
		fs.writeFileSync(eventsPath(), ev('user.message', { content: 'old' }, 'a'));
		const [s] = listCopilotSessions(home);
		const r1 = readCopilotEvents(s!, undefined)!;
		fs.writeFileSync(eventsPath(), ev('user.message', { content: 'new!' }, 'b'));
		const r2 = readCopilotEvents(s!, r1.state)!;
		expect(r2.reset).toBe(true);
		expect(r2.prompts.map(p => p.text)).toEqual(['new!']);
	});

	it('parses workspace.yaml metadata', () => {
		fs.writeFileSync(path.join(home, 'session-state', SID, 'workspace.yaml'),
			`id: ${SID}\ncwd: c:\\src\\x\nrepository: owner/x\nbranch: main\nclient_name: github/cli\nname: "Fix: the thing"\ncreated_at: 2026-09-01T09:00:00.000Z\n`);
		const [s] = listCopilotSessions(home);
		const info = readCopilotSessionInfo(s!);
		expect(info).toMatchObject({ key: `copilot:${SID}`, repository: 'owner/x', branch: 'main', client: 'github/cli', title: 'Fix: the thing', cwd: 'c:\\src\\x' });
	});

	it('classifies message origins', () => {
		expect(classifyCopilotOrigin({})).toBe('human');
		expect(classifyCopilotOrigin({ source: 'system' })).toBe('system');
		expect(classifyCopilotOrigin({ source: 'skill-orchestrate' })).toBe('skill');
		expect(classifyCopilotOrigin({ source: 'agent-1234' })).toBe('agent');
		expect(classifyCopilotOrigin({ isAutopilotContinuation: true })).toBe('autopilot');
	});
});
