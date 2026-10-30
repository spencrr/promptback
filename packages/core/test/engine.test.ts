import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { type EmbeddingProvider, l2normalize } from '../src/embed/provider.js';
import { embeddingProviders } from '../src/embed/registry.js';
import { PromptSearchEngine } from '../src/engine.js';
import { sessionOpenTargets } from '../src/links.js';
import { chunkText } from '../src/search/chunk.js';

/** Deterministic toy embedder: hashed bag of (synonym-normalized) words. */
class FakeEmbedder implements EmbeddingProvider {
	readonly info = { fingerprint: 'fake:v1', displayName: 'fake', dims: 64, local: true };
	calls = 0;
	private static readonly SYN: Record<string, string> = {
		pager: 'doc',
		document: 'doc',
		writeup: 'doc',
		design: 'doc',
		spec: 'doc',
	};
	private vec(text: string): Float32Array {
		const v = new Float32Array(64);
		for (const w of text.toLowerCase().match(/[a-z]+/gu) ?? []) {
			const t = FakeEmbedder.SYN[w] ?? w;
			let h = 0;
			for (const ch of t) {
				// biome-ignore lint/suspicious/noBitwiseOperators: 32-bit wraparound for the toy hash.
				h = (h * 31 + ch.charCodeAt(0)) >>> 0;
			}
			v[h % 64] = v[h % 64]! + 1;
		}
		return l2normalize(v);
	}
	embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
		this.calls += texts.length;
		return Promise.resolve(texts.map(t => this.vec(t)));
	}
	embedQuery(text: string): Promise<Float32Array> {
		return Promise.resolve(this.vec(text));
	}
	dispose(): Promise<void> {
		return Promise.resolve();
	}
}

let tmp: string;
let copilotHome: string;
let vscodeRoot: string;

function writeSession(id: string, yaml: string, events: { type: string; data: object; id: string; ts?: string }[]) {
	const dir = path.join(copilotHome, 'session-state', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml);
	fs.writeFileSync(
		path.join(dir, 'events.jsonl'),
		`${events
			.map(e =>
				JSON.stringify({ type: e.type, data: e.data, id: e.id, timestamp: e.ts ?? '2026-09-10T10:00:00.000Z' }),
			)
			.join('\n')}\n`,
	);
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-engine-'));
	copilotHome = path.join(tmp, 'copilot');
	vscodeRoot = path.join(tmp, 'Code');
	const design = 'Write a design doc for the tree view in CoPyRIT with goals and non-goals';
	writeSession(
		'sess-a',
		'id: sess-a\nrepository: owner/PyRIT\nclient_name: vscode-agent-host\nname: Tree view doc\ncreated_at: 2026-09-01T09:00:00.000Z\n',
		[
			{ type: 'user.message', data: { content: design }, id: 'm1', ts: '2026-09-01T10:00:00.000Z' },
			{ type: 'user.message', data: { content: 'continue' }, id: 'm2' },
			{
				type: 'user.message',
				data: { content: 'Summarize the kusto incident query results', source: 'agent-xyz' },
				id: 'm3',
			},
		],
	);
	// A fork copies the same prompt (same event id) into a new session.
	writeSession(
		'sess-b',
		'id: sess-b\nrepository: owner/PyRIT\nclient_name: vscode-agent-host\nname: Tree view doc (fork)\ncreated_at: 2026-09-02T09:00:00.000Z\n',
		[{ type: 'user.message', data: { content: design }, id: 'm1', ts: '2026-09-02T10:00:00.000Z' }],
	);
	writeSession('sess-c', 'id: sess-c\ncwd: c:\\src\\other\nclient_name: github/cli\n', [
		{ type: 'user.message', data: { content: 'Fix the flaky retry_policy test in the HTTP client' }, id: 'c1' },
	]);
	fs.mkdirSync(path.join(copilotHome, 'session-state', 'empty-session'), { recursive: true });

	const ws = path.join(vscodeRoot, 'User', 'workspaceStorage', 'abc123');
	fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
	fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/src/webapp' }));
	fs.writeFileSync(
		path.join(ws, 'chatSessions', 'chat-1.jsonl'),
		`${[
			{
				kind: 0,
				v: { version: 3, sessionId: 'chat-1', creationDate: Date.parse('2026-09-05T00:00:00Z'), requests: [] },
			},
			{
				kind: 2,
				k: ['requests'],
				v: [
					{
						requestId: 'r1',
						timestamp: Date.parse('2026-09-05T00:01:00Z'),
						message: { text: 'How do I center a div with flexbox?' },
					},
				],
			},
		]
			.map(e => JSON.stringify(e))
			.join('\n')}\n`,
	);

	const ahDir = path.join(vscodeRoot, 'agentSessionData', 'host-1');
	fs.mkdirSync(ahDir, { recursive: true });
	const db = new DatabaseSync(path.join(ahDir, 'session.db'));
	db.exec('CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
	db.prepare('INSERT INTO session_metadata VALUES (?, ?)').run(
		'defaultChatProviderData',
		JSON.stringify({ sdkSessionId: 'sess-a' }),
	);
	db.prepare('INSERT INTO session_metadata VALUES (?, ?)').run(
		'peerChats',
		JSON.stringify([{ uri: 'ahp-chat://chat-9/xyz', providerData: JSON.stringify({ sdkSessionId: 'sess-b' }) }]),
	);
	db.close();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(engines.splice(0).map(e => e.close().catch(() => undefined)));
	fs.rmSync(tmp, { recursive: true, force: true });
});

const engines: PromptSearchEngine[] = [];

/** Only the fixture sources: the Copilot home and VS Code root under `tmp`, never this machine's own history. */
function fixtureSources(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const roots = [{ product: 'Code', root: vscodeRoot }];
	return {
		copilot: { home: copilotHome },
		'vscode-chat': { roots },
		'agent-host': { roots },
		'claude-code': { enabled: false },
		codex: { enabled: false },
		...overrides,
	};
}

function open(provider?: EmbeddingProvider) {
	const e = PromptSearchEngine.open({
		indexDir: path.join(tmp, 'index'),
		sources: fixtureSources(),
		embeddingProvider: provider,
		embedding: provider ? undefined : { kind: 'none' },
	});
	engines.push(e);
	return e;
}

describe('PromptSearchEngine', () => {
	it('ingests all sources, embeds human prompts and dedupes embeddings by content', async () => {
		const fake = new FakeEmbedder();
		const engine = open(fake);
		const r = await engine.sync();
		expect(r.leader).toBe(true);
		expect(r.addedPrompts).toBe(6);
		expect(r.errors).toEqual([]);
		const s = engine.status();
		expect(s.promptsByOrigin).toEqual({ human: 5, agent: 1 });
		expect(s.promptsBySource).toEqual({ copilot: 5, 'vscode-chat': 1 });
		// 4 distinct human texts (fork duplicate shares one embedding); agent message is lexical-only.
		expect(fake.calls).toBe(4);
		expect(s.embeddedChunks).toBe(4);

		const again = await engine.sync();
		expect(again.addedPrompts).toBe(0);
		expect(again.embeddedChunks).toBe(0);
		await engine.close();
	});

	it('finds paraphrases semantically, collapses fork duplicates and resolves Agents-window links', async () => {
		const engine = open(new FakeEmbedder());
		await engine.sync();
		const res = await engine.search('one pager about the tree view');
		expect(res.semanticUnavailable).toBe(false);
		const top = res.hits[0]!;
		expect(top.prompt.text).toMatch(/design doc for the tree view/u);
		expect(top.duplicates).toHaveLength(1);
		expect(top.semanticRank).toBe(1);
		const link = sessionOpenTargets(top.session)[0]!;
		expect(link.kind).toBe('agents-window');
		expect(link.uri).toMatch(/^vscode:\/\/agents\/agent-host-session\/copilotcli\/host-1/u);
		await engine.close();
	});

	it('applies filters, hides acks and agent messages by default', async () => {
		const engine = open(new FakeEmbedder());
		await engine.sync();
		expect((await engine.search('kusto incident')).hits.map(h => h.prompt.origin)).not.toContain('agent');
		expect((await engine.search('kusto incident from:any')).hits[0]!.prompt.origin).toBe('agent');
		expect((await engine.search('continue')).hits.map(h => h.prompt.text)).not.toContain('continue');
		expect((await engine.search('continue is:ack')).hits.map(h => h.prompt.text)).toContain('continue');
		const flex = await engine.search('flexbox src:vscode');
		expect(flex.hits).toHaveLength(1);
		expect(flex.hits[0]!.session.workspaceUri).toBe('file:///c%3A/src/webapp');
		// Filters exclude the only lexical match; semantic neighbours from the allowed set may remain.
		expect((await engine.search('retry_policy repo:PyRIT')).hits.map(h => h.prompt.text).join()).not.toMatch(
			/retry_policy/u,
		);
		expect((await engine.search('retry_policy mode:lex repo:PyRIT')).hits).toHaveLength(0);
		expect((await engine.search('retry_policy')).hits[0]!.lexicalRank).toBe(1);
		expect((await engine.search('"tree view" -goals')).hits).toHaveLength(0);
		const recent = await engine.search('');
		expect(recent.hits[0]!.prompt.text).toMatch(/retry_policy/u);
		expect(recent.hits.map(h => h.prompt.timestamp)).toEqual(
			[...recent.hits.map(h => h.prompt.timestamp)].sort((a, b) => b - a),
		);
		await engine.close();
	});

	it('reports why semantic search is unavailable, retries on sync but not on every search', async () => {
		let attempts = 0;
		embeddingProviders.register({
			id: 'broken-test-provider',
			label: 'Broken',
			description: 'Fails to load, like a missing native binary.',
			local: true,
			options: z.object({}),
			create: () => {
				attempts++;
				return Promise.reject(
					new Error('This installation of ONNX Runtime only contains binaries for win32-x64.'),
				);
			},
		});
		const engine = PromptSearchEngine.open({
			indexDir: path.join(tmp, 'index'),
			sources: fixtureSources(),
			embedding: { kind: 'broken-test-provider' },
		});
		engines.push(engine);

		const synced = await engine.sync();
		expect(attempts).toBe(1);
		expect(synced.semantic).toEqual({
			state: 'failed',
			reason: 'This installation of ONNX Runtime only contains binaries for win32-x64.',
		});
		expect(synced.errors).toEqual([
			'Semantic search unavailable: This installation of ONNX Runtime only contains binaries for win32-x64.',
		]);

		// Keyword results still come back, carrying the reason; the failed load is not repeated per search.
		const res = await engine.search('tree view');
		expect(res.hits.length).toBeGreaterThan(0);
		expect(res.semanticUnavailable).toBe(true);
		expect(res.semantic.state).toBe('failed');
		await engine.search('retry policy');
		expect((await engine.explore('tree view')).semantic.state).toBe('failed');
		expect(attempts).toBe(1);
		expect(engine.status().semantic.state).toBe('failed');
		expect(engine.status().errors[0]).toMatch(/^Semantic search unavailable: /u);

		// An explicit sync tries again (the user may have fixed the installation).
		await engine.sync();
		expect(attempts).toBe(2);
		await engine.close();
	});

	it('distinguishes embeddings that are off from ones still pending', async () => {
		const off = open();
		await off.sync();
		const res = await off.search('tree view');
		expect(res.semanticUnavailable).toBe(true);
		expect(res.semantic).toEqual({ state: 'off' });
		expect(off.status().semantic).toEqual({ state: 'off' });
		await off.close();

		// A loaded model with nothing embedded yet: pending, not failed.
		const fresh = open(new FakeEmbedder());
		await fresh.sync({ embed: false });
		expect((await fresh.search('tree view')).semantic).toEqual({ state: 'pending' });
		await fresh.sync();
		expect((await fresh.search('tree view')).semantic).toEqual({ state: 'ready' });
		await fresh.close();
	});

	it('works lexical-only without a model and removes deleted sessions', async () => {
		const engine = open();
		await engine.sync();
		const res = await engine.search('tree view');
		expect(res.hits.length).toBeGreaterThan(0);
		fs.rmSync(path.join(copilotHome, 'session-state', 'sess-c'), { recursive: true });
		const r = await engine.sync();
		expect(r.removedPrompts).toBe(1);
		expect((await engine.search('retry_policy')).hits).toHaveLength(0);
		await engine.close();
	});

	it('syncs with the source settings saved in the index when given none (CLI, MCP)', async () => {
		const ext = PromptSearchEngine.open({
			indexDir: path.join(tmp, 'index'),
			sources: fixtureSources({ 'vscode-chat': { enabled: false } }),
			retainDeleted: true,
			embedding: { kind: 'none' },
		});
		engines.push(ext);
		await ext.sync();
		await ext.close();
		fs.rmSync(path.join(copilotHome, 'session-state', 'sess-c'), { recursive: true });

		// Like `promptback index` on a machine whose own Copilot home is elsewhere.
		vi.stubEnv('COPILOT_HOME', path.join(tmp, 'elsewhere'));
		const cli = PromptSearchEngine.open({ indexDir: path.join(tmp, 'index'), embedding: { kind: 'none' } });
		engines.push(cli);
		const r = await cli.sync();
		expect(r.removedPrompts).toBe(0);
		expect(cli.status().promptsBySource).toEqual({ copilot: 5 });
		expect((await cli.search('retry_policy')).hits).toHaveLength(1);
		expect(cli.describeSources().map(s => [s.id, s.enabled])).toEqual([
			['copilot', true],
			['vscode-chat', false],
			['agent-host', true],
			['claude-code', false],
			['codex', false],
		]);
	});

	it('reads version-1 source settings written by older builds', async () => {
		const ext = open();
		await ext.sync();
		await ext.close();
		// An older build saved the flat shape; the Copilot source stays off and the home is kept.
		const legacy = PromptSearchEngine.open({ indexDir: path.join(tmp, 'index'), embedding: { kind: 'none' } });
		engines.push(legacy);
		legacy.store.setMeta('sources', JSON.stringify({ copilotHome: null, vscodeChat: false, retainDeleted: true }));
		expect(legacy.describeSources().find(s => s.id === 'copilot')).toMatchObject({ enabled: false });
		expect(legacy.describeSources().find(s => s.id === 'vscode-chat')).toMatchObject({ enabled: false });
		legacy.store.setMeta('sources', JSON.stringify({ copilotHome: 'c:\\elsewhere' }));
		expect(legacy.describeSources().find(s => s.id === 'copilot')).toMatchObject({
			enabled: true,
			options: { home: 'c:\\elsewhere' },
		});
	});

	it('reports invalid source options instead of failing the sync', async () => {
		const e = PromptSearchEngine.open({
			indexDir: path.join(tmp, 'index'),
			sources: fixtureSources({ codex: { enabled: 'yes', home: 42 } }),
			embedding: { kind: 'none' },
		});
		engines.push(e);
		const r = await e.sync();
		expect(r.addedPrompts).toBe(6);
		expect(r.errors.join('\n')).toMatch(/prompt source 'codex'.*enabled.*home/su);
	});

	it('loads the model only for queries that need it and frees memory when idle', async () => {
		const engine = open(new FakeEmbedder());
		await engine.sync({ embed: false });
		await engine.search('retry_policy mode:lex');
		await engine.search('');
		await engine.explore('');
		await engine.explore('tree view mode:lex');
		expect(engine.modelLoaded).toBe(false);
		await engine.search('tree view');
		expect(engine.modelLoaded).toBe(true);
		expect(await engine.releaseIfIdle(60_000)).toBe(false);
		expect(await engine.releaseIfIdle(0)).toBe(true);
		expect((await engine.search('retry_policy mode:lex')).hits).toHaveLength(1);
	});

	it('lets only one process index at a time', async () => {
		const a = open(new FakeEmbedder());
		const b = open(new FakeEmbedder());
		a.store.tryAcquireLease('someone-else', 60_000);
		const r = await b.sync();
		expect(r.leader).toBe(false);
	});

	it('takes over a lease held by a dead process on this machine', async () => {
		const a = open(new FakeEmbedder());
		a.store.tryAcquireLease(`${os.hostname()}:999999999:dead`, 60_000);
		expect((await a.sync()).leader).toBe(true);
	});

	it('embeds the exact chunk text for prompts with non-BMP characters', async () => {
		const text = `${'🚀'.repeat(50)} ${'alpha beta gamma delta. '.repeat(200)}`;
		writeSession('sess-emoji', 'id: sess-emoji\n', [{ type: 'user.message', data: { content: text }, id: 'x1' }]);
		const seen: string[] = [];
		const fake = new FakeEmbedder();
		const orig = fake.embedDocuments.bind(fake);
		fake.embedDocuments = texts => {
			seen.push(...texts);
			return orig(texts);
		};
		const engine = open(fake);
		await engine.sync();
		const chunks = chunkText(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(seen).toContain(c.text);
		}
	});

	it('re-chunks every stored prompt when the chunking options change, keeping vectors of unchanged chunks', async () => {
		const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about the parser and its tokens.`).join('\n');
		writeSession('sess-long', 'id: sess-long\n', [{ type: 'user.message', data: { content: long }, id: 'l1' }]);
		const first = new FakeEmbedder();
		const a = PromptSearchEngine.open({
			indexDir: path.join(tmp, 'index'),
			sources: fixtureSources(),
			embeddingProvider: first,
		});
		engines.push(a);
		await a.sync();
		const before = a.status();
		expect(before.pendingChunks).toBe(0);
		await a.close();

		// Smaller chunks: more of them, and the ones whose text changed need new vectors; the short prompts keep theirs.
		const second = new FakeEmbedder();
		const b = PromptSearchEngine.open({
			indexDir: path.join(tmp, 'index'),
			sources: fixtureSources(),
			embeddingProvider: second,
			chunking: { targetChars: 300, overlapChars: 40 },
		});
		engines.push(b);
		const r = await b.sync();
		const after = b.status();
		expect(after.chunks).toBeGreaterThan(before.chunks);
		expect(after.pendingChunks).toBe(0);
		expect(r.embeddedChunks).toBeGreaterThan(0);
		expect(second.calls).toBeLessThan(after.chunks);
		// Same options again: nothing to redo.
		expect((await b.sync()).embeddedChunks).toBe(0);
	});

	it('derives fork lineage from shared event ids', async () => {
		const engine = open();
		await engine.sync();
		const fork = (await engine.explore('tree view')).sessions['copilot:sess-b']!;
		expect(fork.forkOf).toBe('copilot:sess-a');
		expect(fork.forkPointSeq).toBe(0);
		expect((await engine.explore('tree view')).sessions['copilot:sess-a']!.forkOf).toBeUndefined();
	});

	it('explore returns every matching occurrence (no collapsing, no per-session cap, all origins)', async () => {
		writeSession(
			'sess-many',
			'id: sess-many\nrepository: owner/big\n',
			Array.from({ length: 6 }, (_, i) => ({
				type: 'user.message',
				data: { content: `Refactor the parser module step ${i}` },
				id: `p${i}`,
			})),
		);
		const engine = open(new FakeEmbedder());
		await engine.sync();

		const quick = await engine.search('refactor parser');
		expect(quick.hits.filter(h => h.session.key === 'copilot:sess-many')).toHaveLength(3);
		expect(quick.hits.find(h => h.session.key === 'copilot:sess-many' && h.moreInSession > 0)?.moreInSession).toBe(
			3,
		);

		const ex = await engine.explore('refactor parser');
		expect(ex.rows.filter(r => r.sessionKey === 'copilot:sess-many')).toHaveLength(6);
		expect(ex.rows.every(r => r.matchedLexical || r.matchedSemantic || ex.rows.indexOf(r) < 20)).toBe(true);

		const tree = await engine.explore('design doc tree view');
		expect(tree.rows.filter(r => /design doc/u.test(r.preview))).toHaveLength(2);
		expect(new Set(tree.rows.filter(r => /design doc/u.test(r.preview)).map(r => r.hash)).size).toBe(1);

		const all = await engine.explore('');
		expect(all.rows).toHaveLength(12);
		expect(all.rows.map(r => r.origin)).toContain('agent');
		expect(all.rows.some(r => r.isAck)).toBe(true);
		expect(all.rows.map(r => r.timestamp)).toEqual([...all.rows.map(r => r.timestamp)].sort((a, b) => b - a));
		expect(all.revision).toBeTruthy();
	});

	it('refreshes session metadata in search results when only the title changes', async () => {
		const engine = open(new FakeEmbedder());
		await engine.sync();
		expect((await engine.search('retry_policy')).hits[0]!.session.title).toBeUndefined();
		const yaml = path.join(copilotHome, 'session-state', 'sess-c', 'workspace.yaml');
		fs.writeFileSync(yaml, 'id: sess-c\ncwd: c:\\src\\other\nclient_name: github/cli\nname: Flaky retry fix\n');
		fs.utimesSync(yaml, new Date(), new Date(Date.now() + 5000));
		await engine.sync();
		expect((await engine.search('retry_policy')).hits[0]!.session.title).toBe('Flaky retry fix');
	});
});
