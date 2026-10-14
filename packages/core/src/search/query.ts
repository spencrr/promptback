import { sourceAliases } from '../sources/registry.js';
import type { PromptOrigin, SearchFilters, SearchMode } from '../types.js';
import { ALL_ORIGINS } from '../types.js';

export interface ParsedQuery {
	readonly raw: string;
	/** Free text with operators removed (used for embedding). */
	readonly freeText: string;
	/** Lowercased content tokens (stopwords removed) for lexical retrieval. */
	readonly terms: readonly string[];
	/** Raw free-text tokens, used for the identifier heuristic. */
	readonly rawTokens: readonly string[];
	readonly phrases: readonly string[];
	readonly excluded: readonly string[];
	readonly filters: SearchFilters;
	readonly mode?: SearchMode;
	readonly sort: 'relevance' | 'recent';
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const STOPWORDS = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our '
	+ 'so that the their them then there these this those to was we were what when where which who why will with would you your about '
	+ 'should just like want need get make use using please let lets also any some all not no yes ok').split(' '));

const KEYS = new Set(['repo', 'branch', 'cwd', 'path', 'after', 'before', 'on', 'during', 'from', 'src', 'source', 'client', 'session', 'model', 'mode', 'sort', 'is']);

/** Mutable parse state that operators update besides the filters. */
interface OperatorContext {
	readonly now: number;
	readonly setMode: (m: SearchMode) => void;
	readonly setSort: (s: 'relevance' | 'recent') => void;
	/** `src:` and `client:` vocabularies from the source registry (resolved once per parse). */
	readonly aliases: ReturnType<typeof sourceAliases>;
}

/** Tokenizes a query into whitespace-separated pieces, keeping quoted segments (with optional `key:` / `-` prefixes) intact. */
function splitQuery(q: string): string[] {
	const out: string[] = [];
	const re = /(-?(?:[a-zA-Z]+:)?"[^"]*"?)|(\S+)/g;
	for (let m = re.exec(q); m; m = re.exec(q)) {
		out.push(m[0]);
	}
	return out;
}

export function contentTokens(text: string): string[] {
	const seen = new Set<string>();
	for (const t of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
		if (t.length > 1 && !STOPWORDS.has(t)) {
			seen.add(t);
		}
	}
	return [...seen];
}

export function parseQuery(raw: string, now = Date.now()): ParsedQuery {
	const free: string[] = [];
	const phrases: string[] = [];
	const excluded: string[] = [];
	const f: Mutable<SearchFilters> = {};
	let mode: SearchMode | undefined;
	let sort: 'relevance' | 'recent' = 'relevance';
	const ctx: OperatorContext = { now, setMode: m => (mode = m), setSort: s => (sort = s), aliases: sourceAliases() };

	for (const tok of splitQuery(raw)) {
		const neg = tok.startsWith('-') && tok.length > 1;
		const body = neg ? tok.slice(1) : tok;
		const op = /^([a-zA-Z]+):(.*)$/s.exec(body);
		if (op && KEYS.has(op[1]!.toLowerCase()) && op[2]) {
			const key = op[1]!.toLowerCase();
			const value = unquote(op[2]);
			if (!neg && applyOperator(f, key, value, ctx)) {
				continue;
			}
		}
		if (body.startsWith('"')) {
			const phrase = unquote(body);
			if (phrase) {
				(neg ? excluded : phrases).push(phrase);
				if (!neg) {
					free.push(phrase);
				}
			}
			continue;
		}
		if (neg) {
			excluded.push(body);
			continue;
		}
		free.push(tok);
	}

	const freeText = free.join(' ').trim();
	return {
		raw,
		freeText,
		terms: contentTokens(freeText),
		rawTokens: free,
		phrases,
		excluded,
		filters: f,
		mode,
		sort,
	};
}

function unquote(v: string): string {
	return v.replace(/^"/, '').replace(/"$/, '').trim();
}

function applyOperator(f: Mutable<SearchFilters>, key: string, value: string, ctx: OperatorContext): boolean {
	const { now, setMode, setSort } = ctx;
	switch (key) {
		case 'repo':
			f.repo = value;
			return true;
		case 'branch':
			f.branch = value;
			return true;
		case 'cwd':
		case 'path':
			f.cwd = value;
			return true;
		case 'session':
			f.sessionKey = value;
			return true;
		case 'model':
			f.model = value;
			return true;
		case 'client': {
			f.client = ctx.aliases.clients.get(value.toLowerCase()) ?? value;
			return true;
		}
		case 'src':
		case 'source': {
			const src = ctx.aliases.sources.get(value.toLowerCase());
			if (!src) {
				return false;
			}
			f.source = src;
			return true;
		}
		case 'from': {
			const v = value.toLowerCase();
			if (v === 'any' || v === 'all' || v === '*') {
				f.origins = ALL_ORIGINS;
				return true;
			}
			const origin = (v === 'me' || v === 'user' ? 'human' : v) as PromptOrigin;
			if (!ALL_ORIGINS.includes(origin)) {
				return false;
			}
			f.origins = [...(f.origins && f.origins !== ALL_ORIGINS ? f.origins : []), origin];
			return true;
		}
		case 'after': {
			const r = parseDateRange(value, now);
			if (!r) {
				return false;
			}
			f.after = r[0];
			return true;
		}
		case 'before': {
			const r = parseDateRange(value, now);
			if (!r) {
				return false;
			}
			f.before = r[0];
			return true;
		}
		case 'on':
		case 'during': {
			const r = parseDateRange(value, now);
			if (!r) {
				return false;
			}
			f.after = r[0];
			f.before = r[1];
			return true;
		}
		case 'mode': {
			const v = value.toLowerCase();
			const m: SearchMode | undefined = v.startsWith('lex') ? 'lexical' : v.startsWith('sem') ? 'semantic' : v === 'hybrid' ? 'hybrid' : undefined;
			if (!m) {
				return false;
			}
			setMode(m);
			return true;
		}
		case 'sort':
			setSort(value.toLowerCase().startsWith('rec') || value.toLowerCase() === 'new' ? 'recent' : 'relevance');
			return true;
		case 'is':
			if (value.toLowerCase() === 'ack') {
				f.includeAcks = true;
				return true;
			}
			return false;
	}
	return false;
}

const DAY = 86_400_000;

/** Parses `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `7d`/`2w`/`3m`/`1y` (ago), `today`, `yesterday` into a local-time [start, end) range. */
export function parseDateRange(v: string, now: number): [number, number] | undefined {
	const s = v.toLowerCase();
	const startOfDay = (t: number) => {
		const d = new Date(t);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	};
	if (s === 'today') {
		const t = startOfDay(now);
		return [t, t + DAY];
	}
	if (s === 'yesterday') {
		const t = startOfDay(now) - DAY;
		return [t, t + DAY];
	}
	let m = /^(\d+)([dwmy])$/.exec(s);
	if (m) {
		const n = Number(m[1]);
		const mult = { d: 1, w: 7, m: 30, y: 365 }[m[2] as 'd' | 'w' | 'm' | 'y'];
		const t = startOfDay(now - n * mult * DAY);
		return [t, now + DAY];
	}
	m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(s);
	if (m) {
		const y = Number(m[1]);
		if (m[3]) {
			const t = new Date(y, Number(m[2]) - 1, Number(m[3])).getTime();
			return [t, t + DAY];
		}
		if (m[2]) {
			return [new Date(y, Number(m[2]) - 1, 1).getTime(), new Date(y, Number(m[2]), 1).getTime()];
		}
		return [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()];
	}
	return undefined;
}

/** Heuristic from the benchmark: identifier-like or short queries favor lexical retrieval. */
export function isIdentifierish(q: ParsedQuery): boolean {
	return q.phrases.length > 0 || q.rawTokens.some(t => /[0-9]|[_./\\#-]|[a-z][A-Z]/.test(t));
}

const ACK_RE = /^(?:continue|go on|go ahead|proceed|yes|yep|yeah|y|ok|okay|k|sure|thanks|thank you|ty|do it|done|next|keep going|lgtm|sounds good|great|perfect|nice|cool)[\s.!]*$/i;

/** Trivial acknowledgements are hidden unless `is:ack` is given. */
export function isAckText(text: string): boolean {
	const t = text.trim();
	return t.length < 40 && ACK_RE.test(t);
}
