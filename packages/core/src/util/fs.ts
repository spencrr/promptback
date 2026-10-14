import * as fs from 'node:fs';

/** Modification time in ms, or `undefined` when the file is missing or unreadable. */
export function mtime(p: string): number | undefined {
	try {
		return fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs;
	} catch {
		return undefined;
	}
}

/** Directory entries, or `[]` when the directory is missing or unreadable. */
export function safeReaddir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Lets pending I/O and IPC run between units of a long synchronous scan. */
export function yieldToLoop(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}
