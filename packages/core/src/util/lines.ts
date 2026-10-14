import * as fs from 'node:fs';

const READ_CHUNK = 1 << 20;
const HEAD_BYTES = 96;

export interface ScanLinesOptions {
	/** First byte offset to read from (must be a line boundary). */
	readonly start: number;
	/** Byte offset to stop at (a snapshot of the file size). */
	readonly end: number;
	/** Decide from the first bytes of a line whether it should be materialized. */
	readonly wantLine: (head: string) => boolean;
	/** Called for every wanted, complete line. */
	readonly onLine: (line: Buffer, offset: number) => void;
	/** Wanted lines larger than this are skipped and counted as oversized. */
	readonly maxLineBytes?: number;
	/** How many leading bytes `wantLine` sees (default 96). */
	readonly headBytes?: number;
}

export interface ScanLinesResult {
	/** Offset just after the last fully consumed line; the next scan should start here. */
	readonly endOffset: number;
	readonly oversized: number;
}

/**
 * Streams a JSONL file without materializing unwanted lines. Copilot `events.jsonl` files can be
 * hundreds of MB (tool output), while the lines we need (`user.message`, ...) are small.
 */
export function scanLines(file: string, opts: ScanLinesOptions): ScanLinesResult {
	const maxLineBytes = opts.maxLineBytes ?? 64 * 1024 * 1024;
	const headBytes = opts.headBytes ?? HEAD_BYTES;
	const fd = fs.openSync(file, 'r');
	let lineStart = opts.start;
	let lastComplete = opts.start;
	let head = '';
	let decided = false;
	let want = false;
	let parts: Buffer[] = [];
	let partsLen = 0;
	let oversized = 0;

	const reset = () => {
		head = '';
		decided = false;
		want = false;
		parts = [];
		partsLen = 0;
	};

	try {
		let pos = opts.start;
		while (pos < opts.end) {
			const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, opts.end - pos));
			const read = fs.readSync(fd, buf, 0, buf.length, pos);
			if (read <= 0) {
				break;
			}
			const chunk = read === buf.length ? buf : buf.subarray(0, read);
			let i = 0;
			while (i < chunk.length) {
				const nl = chunk.indexOf(10, i);
				const segEnd = nl === -1 ? chunk.length : nl;
				const seg = chunk.subarray(i, segEnd);

				if (!decided || want) {
					parts.push(seg);
					partsLen += seg.length;
				}
				if (!decided) {
					head += seg.subarray(0, headBytes - head.length).toString('latin1');
					if (head.length >= headBytes || nl !== -1) {
						decided = true;
						want = opts.wantLine(head);
						if (!want) {
							parts = [];
							partsLen = 0;
						}
					}
				}
				if (want && partsLen > maxLineBytes) {
					oversized++;
					want = false;
					parts = [];
					partsLen = 0;
				}

				if (nl === -1) {
					break;
				}
				if (want && partsLen > 0) {
					opts.onLine(parts.length === 1 ? parts[0]! : Buffer.concat(parts, partsLen), lineStart);
				}
				lastComplete = pos + nl + 1;
				lineStart = lastComplete;
				reset();
				i = nl + 1;
			}
			pos += read;
		}

		// A final line without a trailing newline: accept it only if it is a complete JSON value.
		if (lineStart < opts.end && decided && want && partsLen > 0) {
			const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, partsLen);
			if (isCompleteJson(line)) {
				opts.onLine(line, lineStart);
				lastComplete = opts.end;
			}
		}
	} finally {
		fs.closeSync(fd);
	}
	return { endOffset: lastComplete, oversized };
}

function isCompleteJson(line: Buffer): boolean {
	try {
		JSON.parse(line.toString('utf8'));
		return true;
	} catch {
		return false;
	}
}
