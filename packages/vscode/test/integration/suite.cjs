// Runs inside the VS Code extension host (see runTest.mjs). Exercises the real stack:
// extension -> forked index host -> engine -> real local prompt history (read-only) -> search.
const assert = require('node:assert/strict');
const vscode = require('vscode');

const ID = 'spencrr.agent-window-semantic-search';

async function waitFor(fn, timeoutMs, label) {
	const end = Date.now() + timeoutMs;
	let last;
	while (Date.now() < end) {
		last = await fn();
		if (last) {
			return last;
		}
		await new Promise(r => setTimeout(r, 1000));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

exports.run = async function run() {
	const ext = vscode.extensions.getExtension(ID);
	assert.ok(ext, 'extension is installed');
	const api = await ext.activate();
	const log = m => console.log(`[it] ${m}`);

	const commands = await vscode.commands.getCommands(true);
	for (const c of ['awss.search', 'awss.searchAll', 'awss.reindex', 'awss.showStatus', 'awss.enableInAgentsWindow']) {
		assert.ok(commands.includes(c), `command ${c} registered`);
	}

	// Initial sync runs in the background; wait until prompts are indexed and (at least partly) embedded.
	const status = await waitFor(async () => {
		const s = await api.status();
		log(`status: ${s.prompts} prompts, ${s.embeddedChunks}/${s.chunks} embedded, syncing=${s.syncing}`);
		return s.prompts > 0 && s.embeddedChunks > 0 && !s.syncing ? s : undefined;
	}, 15 * 60_000, 'index');
	assert.ok(status.prompts > 100, 'real prompt history was ingested');

	const res = await api.search('design doc for a tree view');
	log(`search took ${res.tookMs} ms, ${res.hits.length} hits, top: ${res.hits[0]?.prompt.text.slice(0, 60)}`);
	assert.equal(res.semanticUnavailable, false, 'semantic search is available');
	assert.ok(res.hits.length > 0, 'search returns hits');
	assert.ok(res.hits.some(h => h.semanticRank), 'dense retrieval contributed');

	const warm = await api.search('git co-author trailer');
	assert.ok(warm.tookMs < 1000, `warm query is fast (${warm.tookMs} ms)`);

	const filtered = await api.search('src:vscode');
	assert.ok(filtered.hits.every(h => h.session.source === 'vscode-chat'), 'source filter applies');

	// The picker opens without throwing; close it again.
	await vscode.commands.executeCommand('awss.search', 'tree view');
	await new Promise(r => setTimeout(r, process.env.AWSS_IT_HOLD ? Number(process.env.AWSS_IT_HOLD) : 1500));
	await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

	// The preview document provider renders a prompt.
	const id = res.hits[0].prompt.id;
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'awss-prompt', path: '/p.md', query: encodeURIComponent(id) }));
	assert.ok(doc.getText().includes(res.hits[0].prompt.text.slice(0, 40)), 'preview shows the prompt text');

	// The Explorer opens as a custom editor (full editor area, also in the Agents window).
	const hold = Number(process.env.AWSS_IT_EXPLORER_HOLD || 0);
	await vscode.commands.executeCommand('awss.openExplorer', 'design doc for a tree view', 'table');
	const tab = await waitFor(async () => {
		const t = vscode.window.tabGroups.activeTabGroup.activeTab;
		return t && t.input instanceof vscode.TabInputCustom && t.input.viewType === 'awss.explorer' ? t : undefined;
	}, 15_000, 'Explorer tab');
	log(`explorer tab: ${tab.label}`);
	assert.equal(tab.label, 'Prompt Explorer', 'tab shows a friendly title, not the virtual file name');
	assert.equal(tab.input.uri.path, '/Prompt Explorer', 'virtual resource has no extension');

	// Activity-bar views are contributed and populated.
	await vscode.commands.executeCommand('workbench.view.extension.promptHistory');
	const sessions = await api.recentSessions?.();
	if (sessions) {
		assert.ok(sessions.length > 0, 'recent sessions available for the sidebar');
	}
	if (hold) {
		await vscode.commands.executeCommand('awss.openExplorer', 'design doc for a tree view', 'table');
		await new Promise(r => setTimeout(r, hold));
		await vscode.commands.executeCommand('awss.openExplorer', 'design doc for a tree view', 'graph');
		await new Promise(r => setTimeout(r, hold));
		await vscode.commands.executeCommand('awss.openExplorer', '', 'table');
		await new Promise(r => setTimeout(r, hold));
		await vscode.commands.executeCommand('awss.openIndexPanel');
		await new Promise(r => setTimeout(r, hold));
	}
	await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

	// Changing an index setting restarts the host: in-flight requests must settle (not hang) and the new host must serve.
	const inflight = api.sync().then(() => 'resolved', () => 'rejected');
	await vscode.workspace.getConfiguration('awss').update('embedding.threads', 3, vscode.ConfigurationTarget.Global);
	const outcome = await Promise.race([inflight, new Promise(r => setTimeout(() => r('hung'), 30_000))]);
	log(`in-flight sync across restart: ${outcome}`);
	assert.notEqual(outcome, 'hung', 'in-flight request settles when the host restarts');
	const after = await waitFor(async () => api.status().catch(() => undefined), 60_000, 'restarted host');
	assert.ok(after.prompts > 0, 'restarted host serves requests');
	// The old host releases the lease once it has shut down cleanly (well before the 5-minute TTL).
	const t0 = Date.now();
	await waitFor(async () => (await api.sync().catch(() => ({ leader: false }))).leader, 60_000, 'writer lease handover');
	log(`restarted host became leader after ${Date.now() - t0} ms`);
	await vscode.workspace.getConfiguration('awss').update('embedding.threads', undefined, vscode.ConfigurationTarget.Global);
	log('all checks passed');
};
