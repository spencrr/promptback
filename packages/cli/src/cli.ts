#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: the CLI's output is the console (stdout for results, stderr for progress).
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
	type EmbeddingConfig,
	type EngineOptions,
	type IndexStatus,
	isOnnxRuntimeSupported,
	localModels,
	onnxRuntimeTarget,
	PromptSearchEngine,
	promptSources,
	type SearchHit,
	type SearchMode,
	type SemanticStatus,
	sessionOpenTargets,
} from '@promptback/core';
import { serveMcp } from '@promptback/core/mcp';

/** Injected by the build; absent when the TypeScript source runs directly (tests). */
declare const __PROMPTBACK_VERSION__: string | undefined;

const VERSION =
	typeof __PROMPTBACK_VERSION__ === 'string'
		? __PROMPTBACK_VERSION__
		: (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
				.version;

const HELP = `promptback ${VERSION} — semantic search over every prompt you've sent to your AI coding agents

Usage:
  promptback index [--no-embed]             Ingest new prompts and embed them
  promptback search <query...> [--json] [--limit N] [--mode hybrid|semantic|lexical]
  promptback get <promptId>                 Print one prompt (full text)
  promptback status [--json]                Index statistics
  promptback doctor                         Check that semantic search works on this machine (runtime, model, one embedding)
  promptback sources [--json]               Prompt sources and whether each is on
  promptback models                         List local embedding models
  promptback mcp                            Run the MCP server on stdio (for Copilot CLI and other agents)

Query syntax: free text plus repo:, branch:, cwd:, after:, before:, on:, from:(me|agent|skill|system|any),
src:(copilot|vscode-chat|claude-code|codex), client:(cli|agent-host|autopilot|chat|claude|codex), session:,
model:, mode:(lex|sem), sort:recent, is:ack, "exact phrase", -excluded

Options:
  --index-dir <dir>   Index location (default: ~/.promptback, or $PROMPTBACK_HOME)
  --model <id>        Local embedding model (default bge-small-en-v1.5)
  --no-model          Lexical-only (no embeddings)
  --no-download       Never download a model
  --verbose, -v       Log progress to stderr
  --version           Print the version
  --help, -h          This help`;

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			json: { type: 'boolean' },
			limit: { type: 'string' },
			mode: { type: 'string' },
			'index-dir': { type: 'string' },
			model: { type: 'string' },
			'no-model': { type: 'boolean' },
			'no-download': { type: 'boolean' },
			'no-embed': { type: 'boolean' },
			verbose: { type: 'boolean', short: 'v' },
			version: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
	});
	const [cmd, ...rest] = positionals;
	if (values.version) {
		console.log(VERSION);
		return;
	}
	if (!cmd || values.help) {
		console.log(HELP);
		return;
	}
	if (cmd === 'models') {
		for (const m of localModels.list()) {
			console.log(
				`${m.id.padEnd(20)} ${m.dims}d  max ${m.maxTokens} tok  ${m.license.padEnd(10)} ${m.repo ? `${m.repo}@${m.revision.slice(0, 10)}` : '(manifest)'}`,
			);
		}
		return;
	}

	const embedding: EmbeddingConfig = values['no-model'] ? { kind: 'none' } : { kind: 'local', model: values.model };
	if (cmd === 'mcp') {
		await serveMcp(
			{ indexDir: values['index-dir'], embedding, allowModelDownload: !values['no-download'] },
			VERSION,
		);
		return;
	}
	const opts: EngineOptions = {
		indexDir: values['index-dir'],
		embedding,
		allowModelDownload: !values['no-download'],
		log: values.verbose ? m => console.error(`[promptback] ${m}`) : undefined,
	};
	const engine = PromptSearchEngine.open(opts);
	try {
		switch (cmd) {
			case 'index':
				await runIndex(engine, values);
				break;
			case 'search':
				await runSearch(engine, rest.join(' '), values);
				break;
			case 'get': {
				const r = engine.getPrompt(rest[0] ?? '');
				if (!r) {
					console.error('Not found');
					process.exitCode = 1;
					break;
				}
				console.log(values.json ? JSON.stringify(r, null, 2) : r.prompt.text);
				break;
			}
			case 'status':
				printStatus(engine, values.json === true);
				break;
			case 'doctor':
				await runDoctor(engine, values);
				break;
			case 'sources':
				printSources(engine, values.json === true);
				break;
			default:
				console.error(`Unknown command '${cmd}'.\n\n${HELP}`);
				process.exitCode = 2;
		}
	} finally {
		await engine.close();
	}
}

interface Flags {
	readonly json?: boolean;
	readonly limit?: string;
	readonly mode?: string;
	readonly verbose?: boolean;
	readonly 'no-embed'?: boolean;
}

async function runIndex(engine: PromptSearchEngine, values: Flags): Promise<void> {
	let lastLine = '';
	const r = await engine.sync({
		embed: !values['no-embed'],
		onProgress: p => {
			if (process.stderr.isTTY) {
				process.stderr.write(`\r${p.message.padEnd(lastLine.length)}`);
				lastLine = p.message;
			} else if (values.verbose) {
				console.error(p.message);
			}
		},
	});
	if (process.stderr.isTTY) {
		process.stderr.write('\n');
	}
	console.log(
		values.json
			? JSON.stringify(r, null, 2)
			: `+${r.addedPrompts} / -${r.removedPrompts} prompts, ${r.embeddedChunks} chunks embedded, ${r.pendingChunks} pending, ${r.errors.length} errors (${(r.tookMs / 1000).toFixed(1)} s)${r.leader ? '' : ' [another process is indexing]'}`,
	);
	for (const e of r.errors.slice(0, 10)) {
		console.error(`  ! ${e}`);
	}
}

async function runSearch(engine: PromptSearchEngine, text: string, values: Flags): Promise<void> {
	const res = await engine.search({
		text,
		limit: values.limit ? Number(values.limit) : 10,
		mode: values.mode as SearchMode | undefined,
	});
	if (values.json) {
		console.log(JSON.stringify(res, null, 2));
		return;
	}
	if (res.semanticUnavailable && res.semantic.state !== 'off') {
		console.error(`(keyword matches only; ${semanticNote(res.semantic)})`);
	}
	for (const [i, h] of res.hits.entries()) {
		printHit(h, i + 1);
	}
	console.error(`${res.hits.length} hits in ${res.tookMs} ms`);
}

/** One clause on why semantic retrieval did not run. */
function semanticNote(s: SemanticStatus): string {
	switch (s.state) {
		case 'failed':
			return `semantic search unavailable: ${s.reason}`;
		case 'off':
			return 'semantic search is off (--no-model)';
		case 'pending':
			return 'semantic search not ready yet (the model is loading or prompts are still being embedded; `promptback index` embeds them)';
		case 'ready':
			return 'semantic search ready';
	}
}

/**
 * Checks the whole semantic-search path on this machine: platform support, the native runtime, the model (downloading
 * it if allowed) and one embedding. Exit code 1 when semantic search is unavailable, so scripts can tell.
 */
async function runDoctor(engine: PromptSearchEngine, values: Flags): Promise<void> {
	const target = onnxRuntimeTarget();
	const before = engine.status();
	const out = (label: string, value: string) => console.log(`${label.padEnd(10)} ${value}`);
	out('promptback', VERSION);
	out(
		'platform',
		`${target}, Node ${process.version}${isOnnxRuntimeSupported() ? '' : ' (no ONNX Runtime build for this platform)'}`,
	);
	out(
		'index',
		`${before.indexPath} (${(before.indexBytes / 1_048_576).toFixed(1)} MB, ${before.prompts} prompts in ${before.sessions} sessions, ${before.embeddedChunks}/${before.chunks} chunks embedded${before.model ? ` with ${before.model}` : ''})`,
	);
	const sourceState = (s: { enabled: boolean; error?: string }) => {
		if (s.error) {
			return 'INVALID';
		}
		return s.enabled ? 'on' : 'off';
	};
	out(
		'sources',
		engine
			.describeSources()
			.map(s => `${s.id} ${sourceState(s)}`)
			.join(', '),
	);
	if (before.semantic.state === 'off') {
		out('semantic', 'off (--no-model): keyword search only');
		return;
	}
	const t0 = Date.now();
	const provider = await engine.ensureProvider(m => values.verbose && console.error(`[promptback] ${m}`));
	const after = engine.status();
	if (!provider || after.semantic.state === 'failed') {
		out(
			'semantic',
			`UNAVAILABLE: ${after.semantic.state === 'failed' ? after.semantic.reason : 'the model did not load'}`,
		);
		process.exitCode = 1;
		return;
	}
	const v = await provider.embedQuery('doctor');
	out(
		'semantic',
		`OK: ${provider.info.displayName} (${v.length}d) loaded in ${Date.now() - t0} ms${after.pendingChunks > 0 ? `; ${after.pendingChunks} chunks still to embed (run \`promptback index\`)` : ''}`,
	);
}

function printStatus(engine: PromptSearchEngine, json: boolean): void {
	const s = engine.status();
	console.log(
		json
			? JSON.stringify(s, null, 2)
			: [
					`index:     ${s.indexPath}`,
					`sessions:  ${s.sessions}`,
					`prompts:   ${s.prompts}  ${JSON.stringify(s.promptsByOrigin)}  ${JSON.stringify(s.promptsBySource)}`,
					`chunks:    ${s.embeddedChunks}/${s.chunks} embedded (${s.model ?? 'no model loaded'})`,
					`semantic:  ${semanticSummary(s)}`,
					`last sync: ${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never'}`,
					...s.errors.slice(0, 5).map(e => `error:     ${e}`),
				].join('\n'),
	);
}

/** `status` never loads the model, so "pending" there means "loads on the first query", not "loading". */
function semanticSummary(s: IndexStatus): string {
	switch (s.semantic.state) {
		case 'failed':
			return `UNAVAILABLE: ${s.semantic.reason}`;
		case 'off':
			return 'off (--no-model)';
		case 'ready':
			return 'ready';
		case 'pending':
			return s.modelLoaded
				? 'model loaded, prompts still being embedded'
				: 'model not loaded in this process (loads on the first query; `promptback doctor` checks it)';
	}
}

/** Registered sources with the options this index would sync them with (saved by the extension, or defaults). */
function printSources(engine: PromptSearchEngine, json: boolean): void {
	const rows = engine.describeSources();
	if (json) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}
	for (const r of rows) {
		const plugin = promptSources.get(r.id);
		let state = r.enabled ? 'on ' : 'off';
		if (r.error) {
			state = `INVALID (${r.error})`;
		}
		const { enabled: _enabled, ...rest } = (r.options ?? {}) as Record<string, unknown>;
		const extra = Object.keys(rest).length > 0 ? `  ${JSON.stringify(rest)}` : '';
		console.log(`${state}  ${r.id.padEnd(12)} ${plugin?.label ?? ''}${extra}`);
	}
}

function printHit(h: SearchHit, n: number): void {
	const s = h.session;
	const when = new Date(h.prompt.timestamp).toISOString().slice(0, 10);
	const firstLine = h.prompt.text.trim().split(/\r?\n/u, 1)[0]!.slice(0, 110);
	const where = [s.repository ?? s.cwd, s.client, when].filter(Boolean).join(' · ');
	const ranks = [h.lexicalRank ? `L${h.lexicalRank}` : '', h.semanticRank ? `S${h.semanticRank}` : '']
		.filter(Boolean)
		.join(' ');
	const dup = h.duplicates.length > 0 ? `  ×${h.duplicates.length + 1}` : '';
	console.log(`${String(n).padStart(2)}. ${firstLine}`);
	console.log(`    ${s.title ? `"${s.title.slice(0, 60)}" · ` : ''}${where}  [${ranks}]${dup}`);
	const open = sessionOpenTargets(s)[0];
	console.log(`    id: ${h.prompt.id}`);
	if (open?.uri) {
		console.log(`    open: ${open.uri}`);
	} else if (open?.command) {
		console.log(`    resume: ${open.command}`);
	}
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.stack : e);
	process.exit(1);
});
