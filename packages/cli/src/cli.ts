#!/usr/bin/env node
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { type EmbeddingConfig, type EngineOptions, LOCAL_MODELS, PromptSearchEngine, type SearchHit, sessionOpenTargets } from '@promptback/core';
import { serveMcp } from '@promptback/core/mcp';

const HELP = `promptback — Promptback: semantic search over every prompt you've sent to your AI coding agents

Usage:
  promptback index [--no-embed]             Ingest new prompts and embed them
  promptback search <query...> [--json] [--limit N] [--mode hybrid|semantic|lexical]
  promptback get <promptId>                 Print one prompt (full text)
  promptback status [--json]                Index statistics
  promptback models                         List local embedding models
  promptback mcp                            Run the MCP server on stdio (for Copilot CLI and other agents)

Query syntax: free text plus repo:, branch:, cwd:, after:, before:, on:, from:(me|agent|skill|system|any),
src:(cli|vscode), client:(agent-host|cli|autopilot|chat), session:, model:, mode:(lex|sem), sort:recent,
is:ack, "exact phrase", -excluded

Options:
  --index-dir <dir>   Index location (default: ~/.promptback, or $PROMPTBACK_HOME)
  --model <id>        Local embedding model (default bge-small-en-v1.5)
  --no-model          Lexical-only (no embeddings)
  --no-download       Never download a model
  --verbose           Log progress`;

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			'json': { type: 'boolean' },
			'limit': { type: 'string' },
			'mode': { type: 'string' },
			'index-dir': { type: 'string' },
			'model': { type: 'string' },
			'no-model': { type: 'boolean' },
			'no-download': { type: 'boolean' },
			'no-embed': { type: 'boolean' },
			'verbose': { type: 'boolean', short: 'v' },
			'help': { type: 'boolean', short: 'h' },
		},
	});
	const [cmd, ...rest] = positionals;
	if (!cmd || values.help) {
		console.log(HELP);
		return;
	}
	if (cmd === 'models') {
		for (const m of LOCAL_MODELS) {
			console.log(`${m.id.padEnd(20)} ${m.dims}d  max ${m.maxTokens} tok  ${m.license.padEnd(10)} ${m.repo}@${m.revision.slice(0, 10)}`);
		}
		return;
	}

	const embedding: EmbeddingConfig = values['no-model'] ? { kind: 'none' } : { kind: 'local', model: values.model ?? 'bge-small-en-v1.5' };
	if (cmd === 'mcp') {
		const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
		await serveMcp({ indexDir: values['index-dir'], embedding, allowModelDownload: !values['no-download'] }, version);
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
			case 'index': {
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
				console.log(values.json ? JSON.stringify(r, null, 2) : `+${r.addedPrompts} / -${r.removedPrompts} prompts, ${r.embeddedChunks} chunks embedded, ${r.pendingChunks} pending, ${r.errors.length} errors (${(r.tookMs / 1000).toFixed(1)} s)${r.leader ? '' : ' [another process is indexing]'}`);
				for (const e of r.errors.slice(0, 10)) {
					console.error(`  ! ${e}`);
				}
				break;
			}
			case 'search': {
				const text = rest.join(' ');
				const res = await engine.search({
					text,
					limit: values.limit ? Number(values.limit) : 10,
					mode: values.mode as 'hybrid' | 'semantic' | 'lexical' | undefined,
				});
				if (values.json) {
					console.log(JSON.stringify(res, (_k, v) => v, 2));
					break;
				}
				if (res.semanticUnavailable) {
					console.error('(semantic search unavailable — showing keyword matches; run `promptback index`)');
				}
				res.hits.forEach((h, i) => printHit(h, i + 1));
				console.error(`${res.hits.length} hits in ${res.tookMs} ms`);
				break;
			}
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
			case 'status': {
				const s = engine.status();
				console.log(values.json ? JSON.stringify(s, null, 2) : [
					`index:     ${s.indexPath}`,
					`sessions:  ${s.sessions}`,
					`prompts:   ${s.prompts}  ${JSON.stringify(s.promptsByOrigin)}  ${JSON.stringify(s.promptsBySource)}`,
					`chunks:    ${s.embeddedChunks}/${s.chunks} embedded (${s.model ?? 'no model loaded'})`,
					`last sync: ${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never'}`,
					...s.errors.slice(0, 5).map(e => `error:     ${e}`),
				].join('\n'));
				break;
			}
			default:
				console.error(`Unknown command '${cmd}'.\n\n${HELP}`);
				process.exitCode = 2;
		}
	} finally {
		await engine.close();
	}
}

function printHit(h: SearchHit, n: number) {
	const s = h.session;
	const when = new Date(h.prompt.timestamp).toISOString().slice(0, 10);
	const firstLine = h.prompt.text.trim().split(/\r?\n/, 1)[0]!.slice(0, 110);
	const where = [s.repository ?? s.cwd, s.client, when].filter(Boolean).join(' · ');
	const ranks = [h.lexicalRank ? `L${h.lexicalRank}` : '', h.semanticRank ? `S${h.semanticRank}` : ''].filter(Boolean).join(' ');
	const dup = h.duplicates.length ? `  ×${h.duplicates.length + 1}` : '';
	console.log(`${String(n).padStart(2)}. ${firstLine}`);
	console.log(`    ${s.title ? `"${s.title.slice(0, 60)}" · ` : ''}${where}  [${ranks}]${dup}`);
	const open = sessionOpenTargets(s)[0];
	console.log(`    id: ${h.prompt.id}${open?.uri ? `\n    open: ${open.uri}` : open?.command ? `\n    resume: ${open.command}` : ''}`);
}

main().catch(e => {
	console.error(e instanceof Error ? e.stack : e);
	process.exit(1);
});
