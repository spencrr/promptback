import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptSearchEngine } from '../src/engine.js';
import { chunkText } from '../src/search/chunk.js';
import { type EmbeddingProvider, l2normalize } from '../src/embed/provider.js';
import { sessionOpenTargets } from '../src/links.js';

/** Deterministic toy embedder: hashed bag of (synonym-normalized) words. */
class FakeEmbedder implements EmbeddingProvider {
	readonly info = { fingerprint: 'fake:v1', displayName: 'fake', dims: 64, local: true };
	calls = 0;
	private static readonly SYN: Record<string, string> = { pager: 'doc', document: 'doc', writeup: 'doc', design: 'doc', spec: 'doc' };
	private vec(text: string): Float32Array {
		const v = new Float32Array(64);
		for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
			const t = FakeEmbedder.SYN[w] ?? w;
			let h = 0;
			for (const ch of t) {
				h = (h * 31 + ch.charCodeAt(0)) >>> 0;
			}
			v[h % 64] = v[h % 64]! + 1;
		}
		return l2normalize(v);
	}
	async embedDocuments(texts: readonly string[]) {
		this.calls += texts.length;
		return texts.map(t => this.vec(t));
	}
	async embedQuery(text: string) {
		return this.vec(text);
	}
	async dispose() { }
}

let tmp: string;
let copilotHome: string;
let vscodeRoot: string;

function writeSession(id: string, yaml: string, events: { type: string; data: object; id: string; ts?: string }[]) {
	const dir = path.join(copilotHome, 'session-state', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml);
	fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify({ type: e.type, data: e.data, id: e.id, timestamp: e.ts ?? '2026-09-10T10:00:00.000Z' })).join('\n') + '\n');
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awss-engine-'));
	copilotHome = path.join(tmp, 'copilot');
	vscodeRoot = path.join(tmp, 'Code');
	const design = 'Write a design doc for the tree view in CoPyRIT with goals and non-goals';
	writeSession('sess-a', 'id: sess-a\nrepository: owner/PyRIT\nclient_name: vscode-agent-host\nname: Tree view doc\n', [
		{ type: 'user.message', data: { content: design }, id: 'm1', ts: '2026-09-01T10:00:00.000Z' },
		{ type: 'user.message', data: { content: 'continue' }, id: 'm2' },
		{ type: 'user.message', data: { content: 'Summarize the kusto incident query results', source: 'agent-xyz' }, id: 'm3' },
	]);
	// A fork copies the same prompt (same event id) into a new session.
	writeSession('sess-b', 'id: sess-b\nrepository: owner/PyRIT\nclient_name: vscode-agent-host\nname: Tree view doc (fork)\n', [
		{ type: 'user.message', data: { content: design }, id: 'm1', ts: '2026-09-02T10:00:00.000Z' },
	]);
	writeSession('sess-c', 'id: sess-c\ncwd: c:\\src\\other\nclient_name: github/cli\n', [
		{ type: 'user.message', data: { content: 'Fix the flaky retry_policy test in the HTTP client' }, id: 'c1' },
	]);
	fs.mkdirSync(path.join(copilotHome, 'session-state', 'empty-session'), { recursive: true });

	const ws = path.join(vscodeRoot, 'User', 'workspaceStorage', 'abc123');
	fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
	fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/src/webapp' }));
	fs.writeFileSync(path.join(ws, 'chatSessions', 'chat-1.jsonl'), [
		{ kind: 0, v: { version: 3, sessionId: 'chat-1', creationDate: Date.parse('2026-09-05T00:00:00Z'), requests: [] } },
		{ kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: Date.parse('2026-09-05T00:01:00Z'), message: { text: 'How do I center a div with flexbox?' } }] },
	].map(e => JSON.stringify(e)).join('\n') + '\n');

	const ahDir = path.join(vscodeRoot, 'agentSessionData', 'host-1');
	fs.mkdirSync(ahDir, { recursive: true });
	const db = new DatabaseSync(path.join(ahDir, 'session.db'));
	db.exec('CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
	db.prepare('INSERT INTO session_metadata VALUES (?, ?)').run('defaultChatProviderData', JSON.stringify({ sdkSessionId: 'sess-a' }));
	db.prepare('INSERT INTO session_metadata VALUES (?, ?)').run('peerChats', JSON.stringify([{ uri: 'ahp-chat://chat-9/xyz', providerData: JSON.stringify({ sdkSessionId: 'sess-b' }) }]));
	db.close();
});

afterEach(async () => {
	await Promise.all(engines.splice(0).map(e => e.close().catch(() => undefined)));
	fs.rmSync(tmp, { recursive: true, force: true });
});

const engines: PromptSearchEngine[] = [];

function open(provider?: EmbeddingProvider) {
	const e = PromptSearchEngine.open({
		indexDir: path.join(tmp, 'index'),
		copilotHome,
		vscodeRoots: [{ product: 'Code', root: vscodeRoot }],
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
		expect(top.prompt.text).toMatch(/design doc for the tree view/);
		expect(top.duplicates).toHaveLength(1);
		expect(top.semanticRank).toBe(1);
		const link = sessionOpenTargets(top.session)[0]!;
		expect(link.kind).toBe('agents-window');
		expect(link.uri).toMatch(/^vscode:\/\/agents\/agent-host-session\/copilotcli\/host-1/);
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
		expect((await engine.search('retry_policy repo:PyRIT')).hits.map(h => h.prompt.text).join()).not.toMatch(/retry_policy/);
		expect((await engine.search('retry_policy mode:lex repo:PyRIT')).hits).toHaveLength(0);
		expect((await engine.search('retry_policy')).hits[0]!.lexicalRank).toBe(1);
		expect((await engine.search('"tree view" -goals')).hits).toHaveLength(0);
		const recent = await engine.search('');
		expect(recent.hits[0]!.prompt.text).toMatch(/retry_policy/);
		expect(recent.hits.map(h => h.prompt.timestamp)).toEqual([...recent.hits.map(h => h.prompt.timestamp)].sort((a, b) => b - a));
		await engine.close();
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
		const text = '🚀'.repeat(50) + ' ' + 'alpha beta gamma delta. '.repeat(200);
		writeSession('sess-emoji', 'id: sess-emoji\n', [{ type: 'user.message', data: { content: text }, id: 'x1' }]);
		const seen: string[] = [];
		const fake = new FakeEmbedder();
		const orig = fake.embedDocuments.bind(fake);
		fake.embedDocuments = async texts => {
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
