import * as vscode from 'vscode';
import type { EmbeddingConfig, HostInitOptions, IndexStatus, PromptOrigin, SearchQuery, SearchResult, SyncResult } from '@awss/core';
import { PREVIEW_SCHEME, PromptPreviewProvider } from './actions.js';
import { HostClient } from './hostClient.js';
import { showSearchPicker } from './searchPicker.js';

const EXTENSION_ID = 'spencrr.agent-window-semantic-search';

export interface PromptHistoryApi {
	search(query: SearchQuery | string): Promise<SearchResult>;
	status(): Promise<IndexStatus & { syncing: boolean }>;
	sync(): Promise<SyncResult>;
}

export function activate(context: vscode.ExtensionContext): PromptHistoryApi {
	const log = vscode.window.createOutputChannel('Prompt History', { log: true });
	const host = new HostClient(context.asAbsolutePath('dist/host.js'), log);
	const status = vscode.window.createStatusBarItem('awss.indexing', vscode.StatusBarAlignment.Left, -100);
	status.name = 'Prompt History Indexing';
	status.command = 'awss.showStatus';
	context.subscriptions.push(log, host, status);

	const start = () => host.start(buildOptions(context)).then(
		r => log.info(`Index: ${r.indexDir}`),
		e => log.error(`Failed to start index process: ${e instanceof Error ? e.message : e}`),
	);
	let started = start();

	let hideTimer: NodeJS.Timeout | undefined;
	context.subscriptions.push(
		host.onProgress(p => {
			if (p.phase === 'embed' && p.total && p.total >= 20) {
				clearTimeout(hideTimer);
				status.text = `$(sync~spin) Prompt index ${p.done ?? 0}/${p.total}`;
				status.tooltip = 'Embedding prompt history for semantic search (runs locally in the background). Keyword search already works.';
				status.show();
			} else if (p.phase === 'embed' && p.message.startsWith('Downloading')) {
				status.text = '$(cloud-download) Prompt index: downloading model';
				status.tooltip = p.message;
				status.show();
			}
		}),
		host.onSynced(r => {
			hideTimer = setTimeout(() => status.hide(), 1500);
			if (r.errors.length) {
				r.errors.slice(0, 20).forEach(e => log.warn(e));
			}
			if (r.embeddedChunks > 0 || r.addedPrompts > 0) {
				log.info(`Sync: +${r.addedPrompts}/-${r.removedPrompts} prompts, ${r.embeddedChunks} chunks embedded in ${(r.tookMs / 1000).toFixed(1)} s`);
			}
			if (r.leader && r.embeddedChunks > 0 && !context.globalState.get('awss.welcomed')) {
				void context.globalState.update('awss.welcomed', true);
				void vscode.window.showInformationMessage(
					'Your prompt history is indexed for semantic search.',
					'Search Prompts',
				).then(c => c && vscode.commands.executeCommand('awss.search'));
			}
		}),
		vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, new PromptPreviewProvider(host)),
		vscode.commands.registerCommand('awss.search', (query?: string) => showSearchPicker(host, { initialQuery: typeof query === 'string' ? query : undefined })),
		vscode.commands.registerCommand('awss.searchAll', () => showSearchPicker(host, { includeAllOrigins: true })),
		vscode.commands.registerCommand('awss.reindex', () => vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Prompt History', cancellable: false },
			async progress => {
				const sub = host.onProgress(p => progress.report({ message: p.message }));
				try {
					const r = await host.request('sync', { embed: true });
					void vscode.window.showInformationMessage(r.leader
						? `Prompt index updated: +${r.addedPrompts} / -${r.removedPrompts} prompts, ${r.embeddedChunks} chunks embedded.`
						: 'Another VS Code window is updating the shared prompt index; results will appear shortly.');
				} finally {
					sub.dispose();
				}
			},
		)),
		vscode.commands.registerCommand('awss.showStatus', async () => {
			const s = await host.request('status', undefined as never);
			const origins = Object.entries(s.promptsByOrigin).map(([k, v]) => `${k} ${v}`).join(', ');
			const sources = Object.entries(s.promptsBySource).map(([k, v]) => `${k} ${v}`).join(', ');
			const detail = [
				`${s.prompts.toLocaleString()} prompts in ${s.sessions.toLocaleString()} sessions (${origins})`,
				`Sources: ${sources}`,
				`Semantic: ${s.embeddedChunks.toLocaleString()} / ${s.chunks.toLocaleString()} chunks embedded${s.model ? ` with ${s.model}` : ''}`,
				`Last sync: ${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never'}${s.syncing ? ' (syncing now)' : ''}`,
				`Index: ${s.indexPath}`,
				...s.errors.slice(0, 5).map(e => `⚠ ${e}`),
			].join('\n');
			const choice = await vscode.window.showInformationMessage('Prompt History index', { modal: true, detail }, 'Show Log');
			if (choice) {
				log.show();
			}
		}),
		vscode.commands.registerCommand('awss.showLog', () => log.show()),
		vscode.commands.registerCommand('awss.enableInAgentsWindow', async () => {
			const cfg = vscode.workspace.getConfiguration('extensions');
			const current = cfg.get<Record<string, boolean>>('supportAgentsWindow') ?? {};
			await cfg.update('supportAgentsWindow', { ...current, [EXTENSION_ID]: true }, vscode.ConfigurationTarget.Global);
			void vscode.window.showInformationMessage('Prompt History is now allowed in the Agents window. Reload the Agents window to activate it.');
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('awss.embedding') || e.affectsConfiguration('awss.index') || e.affectsConfiguration('awss.sources')) {
				log.info('Settings changed; restarting index process');
				started = start();
			}
		}),
	);

	return {
		search: async q => {
			await started;
			return host.request('search', typeof q === 'string' ? { text: q } : q);
		},
		status: async () => {
			await started;
			return host.request('status', undefined as never);
		},
		sync: async () => {
			await started;
			return host.request('sync', { embed: true });
		},
	};
}

function buildOptions(context: vscode.ExtensionContext): HostInitOptions {
	const c = vscode.workspace.getConfiguration('awss');
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
		copilotHome: c.get<boolean>('sources.copilot', true) ? (c.get<string>('sources.copilotHome') || undefined) : null,
		vscodeChat: c.get<boolean>('sources.vscodeChat', true),
		embedding,
		modelSearchDirs: [context.asAbsolutePath('models')],
		allowModelDownload: c.get<boolean>('embedding.allowDownload', true),
		embedOrigins: c.get<PromptOrigin[]>('index.embedOrigins', ['human']),
		retainDeleted: c.get<boolean>('sources.retainDeleted', false),
		syncIntervalMs: Math.max(0, c.get<number>('index.backgroundIntervalMinutes', 2)) * 60_000,
	};
}

export function deactivate(): void {
	// HostClient is disposed via context.subscriptions (disconnects the child process).
}
