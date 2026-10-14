import { describe, expect, it } from 'vitest';
import { withLineage } from '../src/search/corpus.js';
import type { PromptMeta } from '../src/store.js';
import type { SessionInfo } from '../src/types.js';

const session = (id: string, createdAt: number): SessionInfo => ({
	key: `copilot:${id}`,
	source: 'copilot',
	sessionId: id,
	createdAt,
});
let rowid = 0;
const prompts = (id: string, events: string[]): PromptMeta[] =>
	events.map((e, seq) => ({
		rowid: ++rowid,
		id: `copilot:${id}:${e}`,
		sessionKey: `copilot:${id}`,
		hash: e,
		ts: 0,
		origin: 'human',
		isAck: false,
		seq,
		length: 1,
	}));

describe('withLineage', () => {
	it('links sibling forks to their shared parent, not to each other', () => {
		const s = withLineage(
			[session('A', 1), session('B', 2), session('C', 3)],
			[
				...prompts('A', ['e1', 'e2', 'e3']),
				...prompts('B', ['e1', 'e2', 'b1']),
				...prompts('C', ['e1', 'e2', 'c1']),
			],
		);
		expect(s.get('copilot:B')!.forkOf).toBe('copilot:A');
		expect(s.get('copilot:C')!.forkOf).toBe('copilot:A');
		expect(s.get('copilot:C')!.forkPointSeq).toBe(1);
		expect(s.get('copilot:A')!.forkOf).toBeUndefined();
	});

	it('links a fork of a fork to its direct parent', () => {
		const s = withLineage(
			[session('A', 1), session('B', 2), session('C', 3)],
			[...prompts('A', ['e1']), ...prompts('B', ['e1', 'b1']), ...prompts('C', ['e1', 'b1', 'c1'])],
		);
		expect(s.get('copilot:C')!.forkOf).toBe('copilot:B');
		expect(s.get('copilot:C')!.forkPointSeq).toBe(1);
	});

	it('ignores offset-based fallback ids, which are not globally unique', () => {
		const s = withLineage([session('A', 1), session('B', 2)], [...prompts('A', ['@0']), ...prompts('B', ['@0'])]);
		expect(s.get('copilot:B')!.forkOf).toBeUndefined();
	});
});
