import { describe, expect, it } from 'vitest';
import { projectChatSession, replayMutationLog } from '../src/sources/vscodeChat.js';

const lines = (...entries: unknown[]) => entries.map(e => JSON.stringify(e));

describe('replayMutationLog (mirrors vscode ObjectMutationLog.read)', () => {
	it('applies initial, set, push and delete entries', () => {
		const state = replayMutationLog(
			lines(
				{ kind: 0, v: { requests: [], title: 'a' } },
				{ kind: 1, k: ['title'], v: 'b' },
				{ kind: 2, k: ['requests'], v: [{ id: 1 }, { id: 2 }] },
				{ kind: 2, k: ['requests'], v: [{ id: 3 }] },
				{ kind: 1, k: ['requests', 0, 'id'], v: 10 },
				{ kind: 3, k: ['title'] },
			),
		) as { requests: { id: number }[]; title?: string };
		expect(state.requests.map(r => r.id)).toEqual([10, 2, 3]);
		expect('title' in state).toBe(true);
		expect(state.title).toBeUndefined();
	});

	it('truncates to i before appending, including i = 0', () => {
		const state = replayMutationLog(
			lines(
				{ kind: 0, v: { requests: [1, 2, 3] } },
				{ kind: 2, k: ['requests'], v: [9], i: 1 },
				{ kind: 2, k: ['requests'], i: 0 },
				{ kind: 2, k: ['requests'], v: [7] },
			),
		) as { requests: number[] };
		expect(state.requests).toEqual([7]);
	});

	it('creates a missing array on push and lets a later kind 0 reset state', () => {
		const state = replayMutationLog(
			lines({ kind: 0, v: { a: 1 } }, { kind: 2, k: ['list'], v: ['x'] }, { kind: 0, v: { b: 2 } }),
		);
		expect(state).toEqual({ b: 2 });
	});

	it('rejects logs without an initial entry and prototype-polluting paths', () => {
		expect(() => replayMutationLog(lines({ kind: 1, k: ['a'], v: 1 }))).toThrow(/initial/);
		expect(() => replayMutationLog(lines({ kind: 0, v: {} }, { kind: 1, k: ['__proto__', 'x'], v: 1 }))).toThrow(
			/Unsafe/,
		);
		expect(() => replayMutationLog([])).toThrow(/Empty/);
	});
});

describe('projectChatSession', () => {
	it('extracts submitted requests (object and legacy string messages) and classifies system-initiated ones', () => {
		const file = {
			product: 'Code',
			sessionId: 'file-id',
			path: 'x.jsonl',
			format: 'jsonl' as const,
			workspaceUri: 'file:///c%3A/src/repo',
		};
		const { session, prompts } = projectChatSession(
			file,
			{
				sessionId: 's1',
				creationDate: 1000,
				customTitle: 'My chat',
				requests: [
					{ requestId: 'r1', timestamp: 2000, message: { text: 'first prompt' }, modelId: 'copilot/gpt' },
					{ requestId: 'r2', timestamp: 3000, message: 'legacy prompt' },
					{ requestId: 'r3', timestamp: 4000, message: { text: '   ' } },
					{ requestId: 'r4', timestamp: 5000, message: { text: 'auto' }, isSystemInitiated: true },
					null,
				],
			},
			0,
		);
		expect(session.key).toBe('vscode-chat:Code:s1');
		expect(session.title).toBe('My chat');
		expect(session.cwd?.toLowerCase()).toContain('src');
		expect(prompts.map(p => [p.id, p.text, p.origin, p.seq])).toEqual([
			['vscode-chat:Code:s1:r1', 'first prompt', 'human', 0],
			['vscode-chat:Code:s1:r2', 'legacy prompt', 'human', 1],
			['vscode-chat:Code:s1:r4', 'auto', 'system', 2],
		]);
		expect(prompts[0]!.model).toBe('copilot/gpt');
	});
});
