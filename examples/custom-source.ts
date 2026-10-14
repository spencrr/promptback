// biome-ignore-all lint/suspicious/noConsole: an example that prints what it does.
/**
 * A complete custom prompt source, registered at runtime. It indexes Markdown files whose lines start with `> `
 * (one "prompt" per quoted line), to show every part of the plugin contract without depending on any real tool:
 *
 *   - options validated by a zod schema (here: the folder to scan)
 *   - the shared whole-file sync loop (cursors, deletions, `retainDeleted`)
 *   - a client with a label, icon, colour and query aliases that the CLI, MCP server and Explorer pick up
 *   - an "open" target for a session
 *
 * Run it (needs only Node; no model, no download):  node examples/run.mjs examples/custom-source.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod/v4';
import {
	baseSourceOptions,
	type PromptRecord,
	PromptSearchEngine,
	type PromptSourcePlugin,
	promptSources,
	type SessionInfo,
	syncSessionFiles,
} from '../packages/core/src/index.js';

const options = baseSourceOptions.extend({
	/** Folder whose `*.md` files are scanned; each file is one session. */
	folder: z.string().min(1),
});

const markdownNotes: PromptSourcePlugin<z.infer<typeof options>> = {
	id: 'markdown-notes',
	label: 'Markdown notes',
	description: 'Quoted lines (`> ...`) in Markdown files, one session per file.',
	aliases: ['notes', 'md'],
	options,
	clients: [{ id: 'notes/markdown', label: 'Notes', icon: 'book', color: 'green', aliases: ['notes'] }],

	sync(o, ctx) {
		const files = fs.existsSync(o.folder)
			? fs
					.readdirSync(o.folder)
					.filter(f => f.endsWith('.md'))
					.map(f => ({ path: path.join(o.folder, f), name: f.slice(0, -3) }))
			: [];
		return syncSessionFiles(ctx, {
			kind: 'markdown-notes',
			version: 1,
			files,
			read: (file, stat) => {
				const key = `markdown-notes:${file.name}`;
				const prompts: PromptRecord[] = fs
					.readFileSync(file.path, 'utf8')
					.split(/\r?\n/)
					.filter(line => line.startsWith('> '))
					.map((line, i) => ({
						id: `${key}:${i}`,
						sessionKey: key,
						text: line.slice(2),
						timestamp: stat.mtimeMs,
						origin: 'human',
						seq: i,
					}));
				const session: SessionInfo = {
					key,
					source: 'markdown-notes',
					sessionId: file.name,
					title: file.name,
					cwd: o.folder,
					client: 'notes/markdown',
					updatedAt: stat.mtimeMs,
				};
				return prompts.length > 0 ? { session, prompts } : undefined;
			},
		});
	},

	openTargets(s) {
		return [
			{
				kind: 'terminal-resume',
				label: 'Open the note',
				command: `code "${path.join(s.cwd ?? '.', `${s.sessionId}.md`)}"`,
			},
		];
	},
};

// 1. Register the plugin (before opening an engine).
promptSources.register(markdownNotes);

// 2. A throwaway folder with two notes, and a throwaway index. Every other source is turned off, so nothing on
//    this machine is read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-example-'));
const notes = path.join(tmp, 'notes');
fs.mkdirSync(notes);
fs.writeFileSync(
	path.join(notes, 'planning.md'),
	'# Planning\n\n> Draft a design doc for the tree view, with goals and non-goals\n\nnotes...\n> Compare SQLite FTS5 with a dedicated search service\n',
);
fs.writeFileSync(path.join(notes, 'bugs.md'), '# Bugs\n\n> Fix the flaky retry_policy test in the HTTP client\n');

const engine = PromptSearchEngine.open({
	indexDir: path.join(tmp, 'index'),
	embedding: { kind: 'hashed' },
	sources: Object.fromEntries(
		promptSources.ids().map(id => [id, { enabled: id === 'markdown-notes', folder: notes }]),
	),
});

// 3. Index and search. The new source's aliases work in the query language straight away.
const r = await engine.sync();
console.log(
	`Indexed ${r.addedPrompts} prompts from ${engine
		.describeSources()
		.filter(s => s.enabled)
		.map(s => s.label)
		.join(', ')}`,
);
for (const query of ['design doc tree view', 'retry test src:notes', 'search service client:notes']) {
	const res = await engine.search(query);
	console.log(`\n"${query}" → ${res.hits.length} hit(s)`);
	for (const h of res.hits) {
		console.log(`  ${h.prompt.text}  [${h.session.title}]`);
	}
}
await engine.close();
fs.rmSync(tmp, { recursive: true, force: true });
