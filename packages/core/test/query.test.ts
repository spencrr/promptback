import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/search/chunk.js';
import { isAckText, parseDateRange, parseQuery, splitQuery } from '../src/search/query.js';

describe('splitQuery', () => {
	it('keeps quoted segments whole, with or without a key or exclusion prefix', () => {
		expect(splitQuery('a  "b c" repo:"d e" -"f g" -repo:"h i" j')).toEqual([
			'a',
			'"b c"',
			'repo:"d e"',
			'-"f g"',
			'-repo:"h i"',
			'j',
		]);
	});

	it('runs an unterminated quote to the end and ignores quotes later in a token', () => {
		expect(splitQuery('x "open to the end')).toEqual(['x', '"open to the end']);
		expect(splitQuery('foo"bar baz" ""')).toEqual(['foo"bar', 'baz"', '""']);
		expect(splitQuery('"a b"c')).toEqual(['"a b"', 'c']);
		expect(splitQuery(' \t\n')).toEqual([]);
	});

	it('is linear in the input (queries come from users and from models)', () => {
		// 1 MB of the shapes a backtracking tokenizer would choke on: letters without a colon, and key-like runs.
		for (const text of ['A'.repeat(1_000_000), 'AAAA:'.repeat(200_000), '-'.repeat(1_000_000)]) {
			const t0 = performance.now();
			expect(splitQuery(text)).toHaveLength(1);
			expect(performance.now() - t0).toBeLessThan(2000);
		}
	});
});

describe('chunkText', () => {
	it('keeps short prompts whole and trims surrounding whitespace', () => {
		expect(chunkText('  hello there \n')).toEqual([{ start: 2, end: 13, text: 'hello there' }]);
		expect(chunkText('   ')).toEqual([]);
	});

	it('splits long prompts at boundaries with exact offsets, overlap and a cap', () => {
		const para = (n: number) => `Paragraph ${n}. ${'word '.repeat(80)}`;
		const text = Array.from({ length: 40 }, (_, i) => para(i)).join('\n\n');
		const chunks = chunkText(text, { targetChars: 1000, overlapChars: 150, maxChunks: 5 });
		expect(chunks).toHaveLength(5);
		for (const c of chunks) {
			expect(text.slice(c.start, c.end)).toBe(c.text);
			expect(c.text.length).toBeLessThanOrEqual(1000);
		}
		expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
		expect(chunks[0]!.start).toBe(0);
	});
});

describe('parseQuery', () => {
	const now = new Date(2026, 9, 5, 12).getTime();

	it('extracts operators, phrases and exclusions', () => {
		const q = parseQuery(
			'tree view repo:PyRIT after:2026-09 client:cli "design doc" -draft from:any mode:sem',
			now,
		);
		expect(q.freeText).toBe('tree view design doc');
		expect(q.terms).toEqual(['tree', 'view', 'design', 'doc']);
		expect(q.phrases).toEqual(['design doc']);
		expect(q.excluded).toEqual(['draft']);
		expect(q.filters.repo).toBe('PyRIT');
		expect(q.filters.client).toBe('github/cli');
		expect(q.filters.after).toBe(new Date(2026, 8, 1).getTime());
		expect(q.filters.origins).toContain('agent');
		expect(q.mode).toBe('semantic');
	});

	it('leaves unknown keys, paths and URLs as free text', () => {
		const q = parseQuery('C:\\src\\x https://example.com foo:bar', now);
		expect(q.freeText).toBe('C:\\src\\x https://example.com foo:bar');
		expect(q.filters).toEqual({});
	});

	it('parses relative and calendar dates', () => {
		expect(parseDateRange('2026', now)).toEqual([new Date(2026, 0, 1).getTime(), new Date(2027, 0, 1).getTime()]);
		expect(parseDateRange('2026-09-30', now)![0]).toBe(new Date(2026, 8, 30).getTime());
		expect(parseDateRange('7d', now)![0]).toBe(new Date(2026, 8, 28).getTime());
		expect(parseDateRange('nonsense', now)).toBeUndefined();
	});

	it('handles from:, src: and sort:', () => {
		const q = parseQuery('from:skill from:agent src:vscode sort:recent', now);
		expect(q.filters.origins).toEqual(['skill', 'agent']);
		expect(q.filters.source).toBe('vscode-chat');
		expect(q.sort).toBe('recent');
		expect(q.freeText).toBe('');
	});
});

describe('isAckText', () => {
	it('flags trivial acknowledgements only', () => {
		expect(isAckText('continue')).toBe(true);
		expect(isAckText('Yes!')).toBe(true);
		expect(isAckText('yes, but rename the file first')).toBe(false);
	});
});
