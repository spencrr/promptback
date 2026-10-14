import {
	type EmbeddingConfig,
	type HostInitOptions,
	type IndexStatus,
	type PromptOrigin,
	promptSources,
	type RecentSession,
	type SearchQuery,
	type SearchResult,
	type SyncResult,
} from '@promptback/core';
import * as vscode from 'vscode';
import { copyPrompt, openSession, PREVIEW_SCHEME, PromptPreviewProvider } from './actions.js';
import { ExplorerProvider, openExplorer } from './explorer/explorerProvider.js';
import { HostClient } from './hostClient.js';
import { registerMcpServer } from './mcpProvider.js';
import { showSearchPicker } from './searchPicker.js';
import { IndexTreeProvider, type SessionNode, SessionsTreeProvider } from './sidebar.js';

const EXTENSION_ID = 'spencrr.promptback-vscode';

/** Returned from `activate` for other extensions and integration tests. */
export interface PromptbackApi {
	search: (query: SearchQuery | string) => Promise<SearchResult>;
	status: () => Promise<IndexStatus & { syncing: boolean }>;
	sync: () => Promise<SyncResult>;
	recentSessions: () => Promise<RecentSession[]>;
}

export function activate(context: vscode.ExtensionContext): PromptbackApi {
	const log = vscode.window.createOutputChannel('Promptback', { log: true });
	const host = new HostClient(context.asAbsolutePath('dist/host.js'), log);
	context.subscriptions.push(log, host);

	const start = () =>
		host.start(buildOptions(context)).then(
			r => log.info(`Index: ${r.indexDir}`),
			e => log.error(`Failed to start index process: ${e instanceof Error ? e.message : e}`),
		);
	let started = start();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				['promptback.embedding', 'promptback.index', 'promptback.sources'].some(s => e.affectsConfiguration(s))
			) {
				log.info('Settings changed; restarting index process');
				started = start();
			}
		}),
	);

	const explorer = ExplorerProvider.register(context, host);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, new PromptPreviewProvider(host)),
	);
	registerStatusItem(context, host, log);
	registerSidebar(context, host, explorer);
	registerCommands(context, host, log, explorer);
	registerMcpServer(context, log, () => buildOptions(context));
	void offerAgentsWindow(context);

	const ready = async () => {
		await started;
	};
	return {
		search: async q => {
			await ready();
			return host.request('search', typeof q === 'string' ? { text: q } : q);
		},
		status: async () => {
			await ready();
			return host.request('status', undefined as never);
		},
		sync: async () => {
			await ready();
			return host.request('sync', { embed: true });
		},
		recentSessions: async () => {
			await ready();
			return host.request('recentSessions', { limit: 20 });
		},
	};
}

/** A permanent "Prompts" entry (main window; the Agents window has no status bar) that also shows indexing progress. */
function registerStatusItem(context: vscode.ExtensionContext, host: HostClient, log: vscode.LogOutputChannel): void {
	const item = vscode.window.createStatusBarItem('promptback.status', vscode.StatusBarAlignment.Left, -100);
	item.name = 'Promptback';
	const idle = () => {
		item.text = '$(history) Prompts';
		item.tooltip = 'Open Prompt Explorer (Ctrl+Alt+E) — search everything you have asked Copilot agents';
		item.command = 'promptback.openExplorer';
	};
	idle();
	item.show();
	context.subscriptions.push(
		item,
		host.onProgress(p => {
			if (p.phase === 'embed' && p.total && p.total >= 20) {
				item.text = `$(sync~spin) Prompts ${p.done ?? 0}/${p.total}`;
				item.tooltip =
					'Indexing prompt history for semantic search (locally, in the background). Keyword search already works.';
				item.command = 'promptback.showStatus';
			} else if (p.phase === 'embed' && p.message.startsWith('Downloading')) {
				item.text = '$(cloud-download) Prompts: downloading model';
				item.tooltip = p.message;
			}
		}),
		host.onSynced(r => {
			idle();
			for (const e of r.errors.slice(0, 20)) {
				log.warn(e);
			}
			if (r.embeddedChunks > 0 || r.addedPrompts > 0) {
				log.info(
					`Sync: +${r.addedPrompts}/-${r.removedPrompts} prompts, ${r.embeddedChunks} chunks embedded in ${(r.tookMs / 1000).toFixed(1)} s`,
				);
			}
			if (r.leader && r.embeddedChunks > 0 && !context.globalState.get('promptback.welcomed')) {
				void context.globalState.update('promptback.welcomed', true);
				void vscode.window
					.showInformationMessage(
						'Your prompt history is indexed for semantic search.',
						'Open Prompt Explorer',
						'Quick Search',
					)
					.then(
						c =>
							c &&
							vscode.commands.executeCommand(
								c === 'Quick Search' ? 'promptback.search' : 'promptback.openExplorer',
							),
					);
			}
		}),
	);
}

function registerSidebar(context: vscode.ExtensionContext, host: HostClient, explorer: ExplorerProvider): void {
	const sessions = new SessionsTreeProvider(host);
	const index = new IndexTreeProvider(host);
	let lastRefresh = 0;
	context.subscriptions.push(
		vscode.window.createTreeView('promptback.sessions', { treeDataProvider: sessions, showCollapseAll: true }),
		vscode.window.createTreeView('promptback.index', { treeDataProvider: index }),
		host.onSynced(r => {
			if (r.addedPrompts || r.removedPrompts) {
				sessions.refresh();
			}
			index.refresh();
		}),
		host.onProgress(p => {
			// Throttle: embedding reports progress for every batch.
			if (p.phase !== 'done' && Date.now() - lastRefresh > 2000) {
				lastRefresh = Date.now();
				index.refresh(p.message);
			}
		}),
		vscode.commands.registerCommand('promptback.refreshSidebar', () => {
			sessions.refresh();
			index.refresh();
		}),
		vscode.commands.registerCommand('promptback.revealPrompt', (node: SessionNode) => {
			if (node.kind === 'prompt') {
				return openExplorer(explorer, {
					query: `session:${node.session.session.sessionId}`,
					view: 'table',
					selectId: node.prompt.id,
				});
			}
			if (node.kind === 'session') {
				return openExplorer(explorer, { query: `session:${node.item.session.sessionId}`, view: 'table' });
			}
		}),
		vscode.commands.registerCommand('promptback.copyPromptFromTree', async (node: SessionNode) => {
			if (node.kind === 'prompt') {
				const r = await host.request('getPrompt', node.prompt.id);
				if (r) {
					await copyPrompt(r.prompt);
				}
			}
		}),
		vscode.commands.registerCommand('promptback.openSessionFromTree', (node: SessionNode) => {
			if (node.kind === 'session') {
				return openSession(node.item.session);
			}
			return node.kind === 'prompt' ? openSession(node.session.session) : undefined;
		}),
	);
}

function registerCommands(
	context: vscode.ExtensionContext,
	host: HostClient,
	log: vscode.LogOutputChannel,
	explorer: ExplorerProvider,
): void {
	const command = (id: string, fn: (...args: never[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	command('promptback.search', (query?: unknown) =>
		showSearchPicker(host, {
			initialQuery: typeof query === 'string' ? query : undefined,
			onOpenExplorer: q => openExplorer(explorer, { query: q }),
		}),
	);
	command('promptback.searchAll', () =>
		showSearchPicker(host, { includeAllOrigins: true, onOpenExplorer: q => openExplorer(explorer, { query: q }) }),
	);
	command('promptback.openExplorer', (query?: unknown, view?: unknown) =>
		openExplorer(explorer, {
			query: typeof query === 'string' ? query : undefined,
			view: view === 'graph' || view === 'table' ? view : undefined,
		}),
	);
	command('promptback.openIndexPanel', () => openExplorer(explorer, { panel: 'index' }));
	command('promptback.reindex', () =>
		vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Promptback' },
			async progress => {
				const sub = host.onProgress(p => progress.report({ message: p.message }));
				try {
					const r = await host.request('sync', { embed: true });
					void vscode.window.showInformationMessage(
						r.leader
							? `Prompt index updated: +${r.addedPrompts} / -${r.removedPrompts} prompts, ${r.embeddedChunks} chunks embedded.`
							: 'Another VS Code window is updating the shared prompt index; results will appear shortly.',
					);
				} finally {
					sub.dispose();
				}
			},
		),
	);
	command('promptback.showStatus', async () => {
		const s = await host.request('status', undefined as never);
		const list = (o: Readonly<Record<string, number>>) =>
			Object.entries(o)
				.map(([k, v]) => `${k} ${v}`)
				.join(', ');
		const detail = [
			`${s.prompts.toLocaleString()} prompts in ${s.sessions.toLocaleString()} sessions (${list(s.promptsByOrigin)})`,
			`Sources: ${list(s.promptsBySource)}`,
			`Semantic: ${s.embeddedChunks.toLocaleString()} / ${s.chunks.toLocaleString()} chunks embedded${s.model ? ` with ${s.model}` : ''}`,
			`Last sync: ${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never'}${s.syncing ? ' (syncing now)' : ''}`,
			`Index: ${s.indexPath}`,
			...s.errors.slice(0, 5).map(e => `⚠ ${e}`),
		].join('\n');
		if (await vscode.window.showInformationMessage('Promptback index', { modal: true, detail }, 'Show Log')) {
			log.show();
		}
	});
	command('promptback.showLog', () => log.show());
	command('promptback.enableInAgentsWindow', () => enableInAgentsWindow());
}

async function enableInAgentsWindow(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('extensions');
	const current = cfg.get<Record<string, boolean>>('supportAgentsWindow') ?? {};
	await cfg.update('supportAgentsWindow', { ...current, [EXTENSION_ID]: true }, vscode.ConfigurationTarget.Global);
	void vscode.window.showInformationMessage(
		'Promptback is now allowed in the Agents window (experimental). Reload the Agents window to use it there.',
	);
}

/**
 * The Agents window only runs extensions that are explicitly allowed, and this extension can't run there until it is —
 * so offer it once, from a normal window.
 */
async function offerAgentsWindow(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get('promptback.agentsWindowOffered')) {
		return;
	}
	const allowed = vscode.workspace
		.getConfiguration('extensions')
		.get<Record<string, boolean>>('supportAgentsWindow')?.[EXTENSION_ID];
	if (allowed) {
		return;
	}
	await context.globalState.update('promptback.agentsWindowOffered', true);
	const choice = await vscode.window.showInformationMessage(
		'Use Promptback inside the Agents window too? (Experimental: adds this extension to "extensions.supportAgentsWindow".)',
		'Enable',
		'Not now',
	);
	if (choice === 'Enable') {
		await enableInAgentsWindow();
	}
}
function buildOptions(context: vscode.ExtensionContext): HostInitOptions {
	const c = vscode.workspace.getConfiguration('promptback');
	const provider = c.get<string>('embedding.provider', 'local');
	let embedding: EmbeddingConfig;
	if (provider === 'none') {
		embedding = { kind: 'none' };
	} else if (provider === 'openai-compatible') {
		embedding = {
			kind: 'openai-compatible',
			baseUrl: c.get<string>('embedding.openai.baseUrl', ''),
			model: c.get<string>('embedding.openai.model', 'text-embedding-3-small'),
			apiKeyEnv: c.get<string>('embedding.openai.apiKeyEnv') || undefined,
			dims: c.get<number>('embedding.openai.dimensions') || undefined,
		};
	} else {
		embedding = {
			kind: 'local',
			model: c.get<string>('embedding.model', 'bge-small-en-v1.5'),
			modelDir: c.get<string>('embedding.modelDir') || undefined,
			threads: c.get<number>('embedding.threads', 4),
		};
	}
	return {
		indexDir: c.get<string>('index.directory') || undefined,
		sources: sourceOptionsFromSettings(c),
		embedding,
		modelSearchDirs: [context.asAbsolutePath('models')],
		allowModelDownload: c.get<boolean>('embedding.allowDownload', true),
		embedOrigins: c.get<PromptOrigin[]>('index.embedOrigins', ['human']),
		retainDeleted: c.get<boolean>('sources.retainDeleted', false),
		syncIntervalMs: Math.max(0, c.get<number>('index.backgroundIntervalMinutes', 2)) * 60_000,
	};
}

/** `promptback.sources.<id>` (on/off) and `promptback.sources.<id>Home` (folder) per registered source, e.g. `claudeCode`. */
export function sourceSettingKey(sourceId: string): string {
	return sourceId.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function sourceOptionsFromSettings(c: vscode.WorkspaceConfiguration): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const source of promptSources.list()) {
		const key = sourceSettingKey(source.id);
		const options: Record<string, unknown> = { enabled: c.get<boolean>(`sources.${key}`, true) };
		const home = c.get<string>(`sources.${key}Home`);
		if (home) {
			options.home = home;
		}
		out[source.id] = options;
	}
	return out;
}

export function deactivate(): void {
	// HostClient is disposed via context.subscriptions (disconnects the child process).
}
