import * as vscode from 'vscode';
import { sessionOpenTargets } from '@yesterprompt/core/links';
import { copyPrompt, insertIntoChat, openSession, previewPrompt } from '../actions.js';
import type { HostClient } from '../hostClient.js';
import type { FromWebview, IndexAction, IndexSettings, OpenRequest, ToWebview } from './messages.js';

export const EXPLORER_VIEW_TYPE = 'yesterprompt.explorer';
const SCHEME = 'yesterprompt';
/**
 * A virtual resource for the Explorer. It has no file extension so VS Code doesn't offer "Configure default editor
 * for '*.x'". It is a custom editor (not a plain webview panel) because in the Agents window only custom editors on a
 * real resource get the whole editor area.
 */
const EXPLORER_URI = vscode.Uri.from({ scheme: SCHEME, path: '/Prompt Explorer' });
const TEXT_FALLBACK = [
	'This is the Prompt Explorer, a virtual page with no text content.',
	'',
	'Open it with "Reopen Editor With… > Prompt Explorer", or press Ctrl+Alt+E (macOS Cmd+Ctrl+E).',
	'',
].join('\n');

const SETTING_KEYS: Record<keyof IndexSettings, string> = {
	provider: 'embedding.provider',
	model: 'embedding.model',
	threads: 'embedding.threads',
	embedOrigins: 'index.embedOrigins',
	allowDownload: 'embedding.allowDownload',
	openaiBaseUrl: 'embedding.openai.baseUrl',
	openaiModel: 'embedding.openai.model',
	backgroundIntervalMinutes: 'index.backgroundIntervalMinutes',
};

/** Opens (or reveals) the Explorer, optionally with a query, view and a prompt to select. */
export async function openExplorer(provider: ExplorerProvider, request?: Partial<OpenRequest>): Promise<void> {
	const open = request && (request.query !== undefined || request.view || request.selectId || request.panel)
		? { query: request.query ?? '', view: request.view, selectId: request.selectId, panel: request.panel }
		: undefined;
	if (open) {
		provider.pending = open;
	}
	await vscode.commands.executeCommand('vscode.openWith', EXPLORER_URI, EXPLORER_VIEW_TYPE, { preview: false });
	if (open) {
		provider.postToAll({ type: 'open', ...open });
	}
}

/** Full-screen, table-first prompt explorer hosted in a webview. One instance per open editor. */
export class ExplorerProvider implements vscode.CustomReadonlyEditorProvider {
	/** Request for an editor that is still loading (delivered with its `init`). */
	pending: OpenRequest | undefined;
	private readonly panels = new Set<vscode.WebviewPanel>();

	constructor(private readonly context: vscode.ExtensionContext, private readonly host: HostClient) { }

	static register(context: vscode.ExtensionContext, host: HostClient): ExplorerProvider {
		const provider = new ExplorerProvider(context, host);
		context.subscriptions.push(
			vscode.workspace.registerFileSystemProvider(SCHEME, new EmptyReadonlyFs(), { isReadonly: true }),
			vscode.window.registerCustomEditorProvider(EXPLORER_VIEW_TYPE, provider, {
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			}),
			host.onSynced(r => {
				if (r.addedPrompts || r.removedPrompts || r.embeddedChunks) {
					provider.postToAll({ type: 'indexChanged' });
				}
				void provider.postStatusToAll();
			}),
			host.onProgress(progress => provider.postToAll({ type: 'progress', progress })),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('yesterprompt')) {
					// The index process restarts on these settings; give it a moment before reporting.
					setTimeout(() => void provider.postStatusToAll(), 1500);
				}
			}),
		);
		return provider;
	}

	postToAll(msg: ToWebview): void {
		for (const p of this.panels) {
			void p.webview.postMessage(msg);
		}
		// A request delivered to an open Explorer must not leak into the next one opened.
		if (msg.type === 'open' && this.panels.size) {
			this.pending = undefined;
		}
	}

	private async statusMessage(): Promise<ToWebview> {
		const settings = readSettings();
		try {
			return { type: 'indexStatus', status: await this.host.request('status', undefined as never), settings };
		} catch (e) {
			return { type: 'indexStatus', settings, error: e instanceof Error ? e.message : String(e) };
		}
	}

	private async postStatusToAll(): Promise<void> {
		if (this.panels.size) {
			this.postToAll(await this.statusMessage());
		}
	}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	resolveCustomEditor(_doc: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
		panel.title = 'Prompt Explorer';
		panel.iconPath = new vscode.ThemeIcon('history');
		panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
		panel.webview.html = this.html(panel.webview, dist);
		this.panels.add(panel);
		const post = (m: ToWebview) => void panel.webview.postMessage(m);

		const sub = panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
			switch (msg.type) {
				case 'ready': {
					const reducedMotion = vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion') === 'on';
					post({ type: 'init', reducedMotion, ...this.pending });
					this.pending = undefined;
					void this.host.request('warm', undefined as never).catch(() => undefined);
					return;
				}
				case 'query':
					try {
						post({ type: 'result', requestId: msg.requestId, result: await this.host.request('explore', msg.text) });
					} catch (e) {
						post({ type: 'error', requestId: msg.requestId, message: e instanceof Error ? e.message : String(e) });
					}
					return;
				case 'detail': {
					const r = await this.host.request('getPrompt', msg.promptId).catch(() => undefined);
					if (!r) {
						return;
					}
					const all = await this.host.request('getSessionPrompts', r.prompt.sessionKey).catch(() => []);
					post({
						type: 'detail',
						requestId: msg.requestId,
						prompt: r.prompt,
						session: r.session,
						sessionPrompts: all.map(p => ({ id: p.id, seq: p.seq, timestamp: p.timestamp, origin: p.origin, text: p.text.slice(0, 300) })),
						openTargets: r.session ? sessionOpenTargets(r.session) : [],
					});
					return;
				}
				case 'action': {
					const r = await this.host.request('getPrompt', msg.promptId).catch(() => undefined);
					if (!r) {
						return;
					}
					switch (msg.action) {
						case 'copy': return copyPrompt(r.prompt);
						case 'insert': return insertIntoChat(r.prompt);
						case 'preview': return previewPrompt(r.prompt, r.session);
						case 'open': return r.session ? openSession(r.session) : undefined;
					}
					return;
				}
				case 'indexStatus':
					post(await this.statusMessage());
					return;
				case 'setSetting':
					await updateSetting(msg.key, msg.value);
					return;
				case 'indexAction':
					await this.indexAction(msg.action);
					post(await this.statusMessage());
					return;
			}
		});
		panel.onDidDispose(() => {
			sub.dispose();
			this.panels.delete(panel);
		});
	}

	private async indexAction(action: IndexAction): Promise<void> {
		switch (action) {
			case 'reindex':
				void this.host.request('sync', { embed: true }).catch(() => undefined);
				return;
			case 'pause':
			case 'resume':
				await this.host.request('setEmbeddingPaused', action === 'pause');
				return;
			case 'rebuild': {
				const ok = await vscode.window.showWarningMessage(
					'Re-embed every prompt with the current model? Keyword search keeps working while it runs.', { modal: true }, 'Rebuild');
				if (ok) {
					await this.host.request('rebuildEmbeddings', undefined as never);
				}
				return;
			}
			case 'openSettings':
				await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.context.extension.id}`);
				return;
			case 'showLog':
				await vscode.commands.executeCommand('yesterprompt.showLog');
				return;
			case 'revealIndex': {
				const status = await this.host.request('status', undefined as never).catch(() => undefined);
				if (status) {
					await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(status.indexPath));
				}
				return;
			}
		}
	}

	private html(webview: vscode.Webview, dist: vscode.Uri): string {
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, f));
		// No remote content of any kind: prompts are private and images/links could exfiltrate them.
		const csp = [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}'`,
			`style-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`img-src ${webview.cspSource} data:`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Prompt Explorer</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
	}
}

function readSettings(): IndexSettings {
	const c = vscode.workspace.getConfiguration('yesterprompt');
	const get = <K extends keyof IndexSettings>(k: K) => c.get(SETTING_KEYS[k]) as IndexSettings[K];
	return {
		provider: get('provider'), model: get('model'), threads: get('threads'), embedOrigins: get('embedOrigins'),
		allowDownload: get('allowDownload'), openaiBaseUrl: get('openaiBaseUrl'), openaiModel: get('openaiModel'),
		backgroundIntervalMinutes: get('backgroundIntervalMinutes'),
	};
}

async function updateSetting(key: keyof IndexSettings, value: unknown): Promise<void> {
	if (!(key in SETTING_KEYS)) {
		return;
	}
	if (key === 'provider' && value === 'openai-compatible') {
		const ok = await vscode.window.showWarningMessage(
			'A remote embedding endpoint receives the text of your prompts. Only continue for endpoints you trust (e.g. Azure OpenAI in your tenant, or a local Ollama).',
			{ modal: true }, 'Use Remote Endpoint');
		if (!ok) {
			return;
		}
	}
	await vscode.workspace.getConfiguration('yesterprompt').update(SETTING_KEYS[key], value, vscode.ConfigurationTarget.Global);
}

/** Backing file system for the Explorer's virtual resource. "Reopen With > Text Editor" can't be hidden, so it explains itself. */
class EmptyReadonlyFs implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private readonly content = new TextEncoder().encode(TEXT_FALLBACK);
	readonly onDidChangeFile = this.emitter.event;
	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}
	stat(): vscode.FileStat {
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.content.byteLength, permissions: vscode.FilePermission.Readonly };
	}
	readDirectory(): [string, vscode.FileType][] {
		return [];
	}
	readFile(): Uint8Array {
		return this.content;
	}
	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions();
	}
	writeFile(): void {
		throw vscode.FileSystemError.NoPermissions();
	}
	delete(): void {
		throw vscode.FileSystemError.NoPermissions();
	}
	rename(): void {
		throw vscode.FileSystemError.NoPermissions();
	}
}
