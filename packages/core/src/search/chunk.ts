export interface Chunk {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export interface ChunkOptions {
	/** Target chunk size in characters (≈ 4 chars/token for English prose; code is denser). */
	readonly targetChars: number;
	/** Overlap between consecutive windows, in characters. */
	readonly overlapChars: number;
	/** Hard cap on chunks per prompt; very long pastes (logs, files) are covered lexically beyond this. */
	readonly maxChunks: number;
}

/** Benchmarked defaults: 512 tokens ≈ 1,434 chars on this corpus, 15% overlap, cap 12 windows (~15k chars). */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetChars: 1434, overlapChars: 215, maxChunks: 12 };

/**
 * Splits a prompt into windows aligned to paragraph / line / sentence / word boundaries.
 * Offsets are UTF-16 indices into the original text so previews and copies stay exact.
 */
export function chunkText(text: string, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
	const trimmedEnd = text.trimEnd().length;
	let start = text.length - text.trimStart().length;
	if (start >= trimmedEnd) {
		return [];
	}
	if (trimmedEnd - start <= opts.targetChars) {
		return [{ start, end: trimmedEnd, text: text.slice(start, trimmedEnd) }];
	}
	const chunks: Chunk[] = [];
	while (start < trimmedEnd && chunks.length < opts.maxChunks) {
		let end = Math.min(trimmedEnd, start + opts.targetChars);
		if (end < trimmedEnd) {
			end = findBreak(text, start + Math.floor(opts.targetChars * 0.6), end);
		}
		const slice = text.slice(start, end);
		if (slice.trim()) {
			chunks.push({ start, end, text: slice });
		}
		if (end >= trimmedEnd) {
			break;
		}
		let next = Math.max(end - opts.overlapChars, start + 1);
		next = alignForward(text, next, end);
		start = next;
	}
	return chunks;
}

const BREAKS: RegExp[] = [/\n\s*\n/g, /\n/g, /[.!?]\s/g, /\s/g];

function findBreak(text: string, min: number, max: number): number {
	const window = text.slice(min, max);
	for (const re of BREAKS) {
		re.lastIndex = 0;
		let last = -1;
		for (let m = re.exec(window); m; m = re.exec(window)) {
			last = m.index + m[0].length;
		}
		if (last > 0) {
			return min + last;
		}
	}
	return max;
}

function alignForward(text: string, pos: number, limit: number): number {
	for (let i = pos; i < limit; i++) {
		const c = text.charCodeAt(i);
		if (c === 10 || c === 32 || c === 9) {
			return i + 1;
		}
	}
	return pos;
}
