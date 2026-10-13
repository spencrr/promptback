import { describe, expect, it } from 'vitest';
import { collectGarbage } from '../src/util/gc.js';

describe('collectGarbage', () => {
	it('runs a full collection without leaving gc exposed', () => {
		const before = typeof (globalThis as { gc?: unknown }).gc;
		expect(() => collectGarbage()).not.toThrow();
		expect(typeof (globalThis as { gc?: unknown }).gc).toBe(before);
	});
});
