import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

/**
 * Runs a full garbage collection. An idle process allocates nothing, so V8 would otherwise keep released memory (the
 * tokenizer, the corpus and its vectors) until its next collection, which may never come. Exposes `gc` only for the
 * call, as jest's leak detector does.
 */
export function collectGarbage(): void {
	const hidden = typeof (globalThis as { gc?: unknown }).gc !== 'function';
	setFlagsFromString('--expose-gc');
	(runInNewContext('gc') as () => void)();
	if (hidden) {
		setFlagsFromString('--no-expose-gc');
	}
}
