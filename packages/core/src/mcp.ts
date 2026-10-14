/**
 * MCP server over the prompt index, for VS Code chat, the Agents window, Copilot CLI and other MCP clients.
 * Stdio transport; every tool is read-only. Clients start one server per session and keep it for the session's
 * lifetime, so an idle server holds as little as possible: the index is refreshed (with a bounded wait) when a tool is
 * called, the embedding model loads only for queries that need it, and the model and corpus are released when idle.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { type EngineOptions, PromptSearchEngine } from './engine.js';
import { sessionOpenTargets } from './links.js';
import { clientLabel, promptSources } from './sources/registry.js';
import type { PromptOrigin, SearchHit, SessionInfo } from './types.js';
import { collectGarbage } from './util/gc.js';

const SNIPPET_CHARS = 300;
const PROMPT_MAX_CHARS = 20_000;
const SESSION_PROMPT_CHARS = 400;
const SESSION_HEAD = 20;
const SESSION_TAIL = 80;
const REFRESH_AFTER_MS = 30_000;
const REFRESH_WAIT_MS = 2000;
const IDLE_RELEASE_MS = 5 * 60_000;

/** Server instructions and query help name the sources and clients the registry knows, so new plugins are advertised. */
function instructions(): string {
	const sources = promptSources
		.list()
		.filter(s => s.clients.length)
		.map(s => s.label)
		.join(', ');
	return `Promptback indexes the prompts this user has sent to AI coding agents (${sources}) across all sessions and repositories.
Use search_prompts to find something the user asked or decided before, to reuse an earlier prompt, or to recover the context of past work. Then use get_prompt or get_session with the ids it returns.
Results are the user's own words and may contain private details, so quote only what the task needs.`;
}

function queryHelp(): string {
	const clients = promptSources
		.list()
		.flatMap(s => s.clients.map(c => c.aliases[0] ?? c.id))
		.join('|');
	const sources = promptSources
		.list()
		.filter(s => s.clients.length)
		.map(s => s.id)
		.join('|');
	return (
		'Free text, matched by meaning and keywords, plus optional filters: repo:NAME branch:NAME cwd:PATH after:DATE before:DATE on:DATE ' +
		`(DATE = 2026-09-30, 2026-09, 7d, 2w, 3m, today, yesterday) client:${clients} src:${sources} from:me|agent|skill|system|any ` +
		'session:ID model:NAME mode:lex|sem sort:recent "exact phrase" -excluded. An empty query lists the most recent prompts.'
	);
}

const AUTHORS: Readonly<Record<PromptOrigin, string>> = {
	human: 'the user',
	agent: 'an agent',
	skill: 'a skill',
	system: 'the system',
	autopilot: 'autopilot',
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export interface McpServerOptions {
	readonly version?: string;
	/** Called before tools that read the index, to pick up new prompts. */
	readonly refresh?: () => Promise<void>;
}

/** Builds the server and its tools; the caller connects a transport. */
export function createMcpServer(engine: PromptSearchEngine, opts: McpServerOptions = {}): McpServer {
	const server = new McpServer(
		{ name: 'promptback', title: 'Promptback', version: opts.version ?? '0.0.0' },
		{ instructions: instructions() },
	);
	const QueryHelp = queryHelp();
	const refresh = opts.refresh ?? (() => Promise.resolve());

	server.registerTool(
		'search_prompts',
		{
			title: 'Search prompt history',
			description:
				'Search the prompts this user sent to AI coding agents in past sessions, by meaning and keywords. Returns the best matches, each with a prompt id (for get_prompt) and a session id (for get_session).',
			inputSchema: {
				query: z.string().describe(QueryHelp),
				limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10).'),
			},
			annotations: READ_ONLY,
		},
		async ({ query, limit }) => {
			await refresh();
			const r = await engine.search({ text: query, limit: limit ?? 10 });
			if (r.hits.length === 0) {
				return textResult(
					`No prompts matched ${JSON.stringify(query)}. Try fewer or different words, or remove filters.`,
				);
			}
			const lines = [
				`${count(r.hits.length, 'prompt')} for ${JSON.stringify(query)}, best first${r.semanticUnavailable ? ' (keyword matches only: semantic search is off or not ready)' : ''}:`,
			];
			for (const [i, h] of r.hits.entries()) {
				lines.push('', ...formatHit(h, i + 1));
			}
			return textResult(lines.join('\n'));
		},
	);

	server.registerTool(
		'get_prompt',
		{
			title: 'Get a past prompt',
			description:
				'The full text of one past prompt, with its session and how to reopen it. Takes a prompt id from search_prompts or get_session.',
			inputSchema: {
				id: z.string().describe('Prompt id exactly as returned, e.g. copilot:<session>:<event>.'),
			},
			annotations: READ_ONLY,
		},
		({ id }) => {
			const r = engine.getPrompt(id.trim());
			if (!r) {
				return toolError(
					`No prompt has the id ${JSON.stringify(id)}. Use an id exactly as search_prompts or get_session returned it.`,
				);
			}
			const p = r.prompt;
			return textResult(
				[
					`Prompt ${p.id}`,
					`Sent ${when(p.timestamp)} by ${AUTHORS[p.origin]}${p.model ? ` (model ${p.model})` : ''}; message #${p.seq + 1} of its session.`,
					...(r.session ? sessionHeader(r.session) : [`Session ${p.sessionKey}`]),
					'',
					clip(p.text, PROMPT_MAX_CHARS),
				].join('\n'),
			);
		},
	);

	server.registerTool(
		'get_session',
		{
			title: 'Get a past session',
			description:
				"A past session's details and the user's prompts in order. Takes a session id from search_prompts or list_recent_sessions (a unique prefix also works).",
			inputSchema: {
				session_id: z
					.string()
					.describe('Session key or id, e.g. copilot:<uuid>, the bare <uuid>, or a unique prefix of either.'),
				include_all_authors: z
					.boolean()
					.optional()
					.describe('Also include messages injected by agents, skills and the system (default false).'),
			},
			annotations: READ_ONLY,
		},
		async ({ session_id, include_all_authors }) => {
			await refresh();
			const found = engine.findSessions(session_id);
			if (found.length !== 1) {
				return toolError(
					found.length > 0
						? `${found.length} sessions match ${JSON.stringify(session_id)}; use a longer id:\n${found
								.slice(0, 10)
								.map(candidate => `- ${candidate.key}${titled(candidate)}`)
								.join('\n')}`
						: `No session matches ${JSON.stringify(session_id)}.`,
				);
			}
			const s = found[0]!;
			const all = engine.getSessionPrompts(s.key);
			const prompts = include_all_authors ? all : all.filter(p => p.origin === 'human');
			const lines = sessionHeader(s);
			if (prompts.length === 0) {
				lines.push(
					'',
					include_all_authors
						? 'No messages are indexed for this session.'
						: 'The user sent no prompts in this session (try include_all_authors).',
				);
				return textResult(lines.join('\n'));
			}
			lines.push(
				'',
				`${count(prompts.length, include_all_authors ? 'message' : 'prompt')} from ${when(prompts[0]!.timestamp)} to ${when(prompts.at(-1)!.timestamp)}:`,
			);
			const omitted = prompts.length - SESSION_HEAD - SESSION_TAIL;
			const shown =
				omitted > 0 ? [...prompts.slice(0, SESSION_HEAD), undefined, ...prompts.slice(-SESSION_TAIL)] : prompts;
			for (const p of shown) {
				if (!p) {
					lines.push('', `… ${count(omitted, 'prompt')} omitted …`);
					continue;
				}
				const long = p.text.length > SESSION_PROMPT_CHARS;
				const by = p.origin === 'human' ? '' : ` · from ${AUTHORS[p.origin]}`;
				lines.push(
					'',
					`#${p.seq + 1} · ${when(p.timestamp)}${by}${long ? ` · truncated, full text: get_prompt ${p.id}` : ''}`,
					`   ${flat(p.text, SESSION_PROMPT_CHARS)}`,
				);
			}
			return textResult(lines.join('\n'));
		},
	);

	server.registerTool(
		'list_recent_sessions',
		{
			title: 'List recent sessions',
			description: "The user's most recently active agent sessions, newest first, with ids for get_session.",
			inputSchema: {
				limit: z.number().int().min(1).max(50).optional().describe('Maximum sessions (default 15).'),
			},
			annotations: READ_ONLY,
		},
		async ({ limit }) => {
			await refresh();
			const recent = engine.recentSessions(limit ?? 15, 1);
			if (recent.length === 0) {
				return textResult('No sessions with prompts from the user are indexed yet.');
			}
			const lines = [`${count(recent.length, 'session')}, most recently active first:`];
			recent.forEach((r, i) => {
				const s = r.session;
				lines.push('', `${i + 1}. ${s.title ? JSON.stringify(flat(s.title, 100)) : s.key} · ${where(s)}`);
				lines.push(`   session: ${s.key} · ${count(r.promptCount, 'prompt')} · last ${when(r.lastActivity)}`);
				const last = r.prompts.at(-1);
				if (last) {
					lines.push(`   last prompt: ${flat(last.preview, 160)}`);
				}
			});
			return textResult(lines.join('\n'));
		},
	);

	server.registerTool(
		'index_status',
		{
			title: 'Prompt index status',
			description: 'How many prompts are indexed, how fresh the index is, and whether semantic search is ready.',
			annotations: READ_ONLY,
		},
		() => {
			const st = engine.status();
			const counts = (c: Readonly<Record<string, number>>) =>
				Object.entries(c)
					.map(([k, v]) => `${k} ${v}`)
					.join(', ');
			return textResult(
				[
					`Index: ${st.indexPath} (${(st.indexBytes / 1_048_576).toFixed(1)} MB)`,
					`Prompts: ${st.prompts} in ${st.sessions} sessions. By author: ${counts(st.promptsByOrigin)}. By source: ${counts(st.promptsBySource)}.`,
					`Semantic search: ${st.embeddedChunks} of ${st.chunks} chunks embedded${st.model ? ` with ${st.model}` : ''}${st.embeddingPaused ? ' (embedding paused)' : ''}.`,
					`Last sync: ${st.lastSyncAt ? when(st.lastSyncAt) : 'never'}${engine.isSyncing ? ' (syncing now)' : ''}.`,
					...st.errors.slice(0, 5).map(e => `Problem: ${e}`),
				].join('\n'),
			);
		},
	);

	return server;
}

/** Serves on stdin/stdout until the client disconnects. */
export async function serveMcp(
	opts: Omit<EngineOptions, 'log' | 'embeddingProvider'> = {},
	version?: string,
): Promise<void> {
	// stdout carries the protocol, so stray console output must go to stderr.
	console.log = console.error;
	console.info = console.error;
	console.debug = console.error;
	const log = (m: string) => console.error(`[promptback] ${m}`);
	const engine = PromptSearchEngine.open({ ...opts, log });

	let lastRefresh = 0;
	const refresh = async () => {
		if (Date.now() - lastRefresh < REFRESH_AFTER_MS) {
			return;
		}
		lastRefresh = Date.now();
		// Embedding needs the model; only embed new prompts once a query has loaded it anyway.
		const run = engine
			.sync({ embed: engine.modelLoaded })
			.catch(e => log(`Sync failed: ${e instanceof Error ? e.message : e}`));
		await Promise.race([run, new Promise(r => setTimeout(r, REFRESH_WAIT_MS).unref())]);
	};
	const server = createMcpServer(engine, { version, refresh });
	const idle = setInterval(
		() => void engine.releaseIfIdle(IDLE_RELEASE_MS).then(freed => freed && collectGarbage()),
		60_000,
	).unref();

	let closed = false;
	const shutdown = async () => {
		if (closed) {
			return;
		}
		closed = true;
		clearInterval(idle);
		await server.close().catch(() => undefined);
		await engine.close().catch(() => undefined);
		process.exit(0);
	};
	process.stdin.once('end', () => void shutdown());
	process.once('SIGINT', () => void shutdown());
	process.once('SIGTERM', () => void shutdown());
	await server.connect(new StdioServerTransport());
	server.server.onclose = () => void shutdown();
	log(`MCP server ready (index: ${engine.indexDir})`);
}

function formatHit(h: SearchHit, n: number): string[] {
	const by = h.prompt.origin === 'human' ? '' : ` · from ${AUTHORS[h.prompt.origin]}`;
	const notes = [
		h.duplicates.length > 0 ? `sent ${h.duplicates.length + 1} times` : '',
		h.moreInSession ? `${count(h.moreInSession, 'more match', 'more matches')} in this session` : '',
	].filter(Boolean);
	return [
		`${n}. ${when(h.prompt.timestamp)} · ${where(h.session)}${by}`,
		`   prompt: ${h.prompt.id}`,
		`   session: ${h.session.key}${titled(h.session)}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
		`   ${snippet(h.prompt.text, h.matchRange)}`,
	];
}

function sessionHeader(s: SessionInfo): string[] {
	const lines = [`Session ${s.key}${titled(s)}`];
	const w = where(s);
	if (w) {
		lines.push(`Where: ${w}`);
	}
	if (s.repository && s.cwd) {
		lines.push(`Folder: ${s.cwd}`);
	}
	if (s.forkOf) {
		lines.push(
			`Forked from ${s.forkOf}${s.forkPointSeq === undefined ? '' : ` after message #${s.forkPointSeq + 1}`}.`,
		);
	}
	for (const t of sessionOpenTargets(s)) {
		const how = t.uri ?? t.command;
		if (how) {
			lines.push(`${t.label}: ${how}${t.kind === 'terminal-resume' && t.cwd ? ` (run in ${t.cwd})` : ''}`);
		}
	}
	return lines;
}

function where(s: SessionInfo): string {
	const place = s.repository
		? `${s.repository}${s.repositoryInferred ? ' (inferred)' : ''}`
		: (s.cwd ?? s.workspaceUri ?? (s.workspaceless ? 'no folder' : undefined));
	return [place, s.branch, s.client && clientLabel(s.client)].filter(Boolean).join(' · ');
}

function titled(s: SessionInfo): string {
	return s.title ? ` ${JSON.stringify(flat(s.title, 80))}` : '';
}

/** The start of the prompt, plus the matching passage when it lies further in. */
function snippet(text: string, range?: readonly [number, number]): string {
	if (!range || range[0] < SNIPPET_CHARS - 60) {
		return flat(text, SNIPPET_CHARS);
	}
	return `${flat(text.slice(0, 120), 120)} … ${flat(text.slice(range[0] - 60, range[1] + 120), SNIPPET_CHARS - 120)}`;
}

/** Collapses whitespace and cuts to `max` characters. */
function flat(text: string, max: number): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters]` : text;
}

function when(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

function textResult(t: string): CallToolResult {
	return { content: [{ type: 'text', text: t }] };
}

function toolError(t: string): CallToolResult {
	return { content: [{ type: 'text', text: t }], isError: true };
}
