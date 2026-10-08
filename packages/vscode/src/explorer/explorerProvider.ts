import * as vscode from 'vscode';
import { sessionOpenTargets } from '@awss/core/links';
import { copyPrompt, insertIntoChat, openSession, previewPrompt } from '../actions.js';
import type { HostClient } from '../hostClient.js';
import type { ExplorerView, FromWebview, ToWebview } from './messages.js';

export const EXPLORER_VIEW_TYPE = 'awss.explorer';
const SCHEME = 'prompt-history';
/** Custom editors on a non-untitled resource get the whole editor area in the Agents window (no docked details). */
const EXPLORER_URI = vscode.Uri.from({ scheme: SCHEME, path: '/Prompt Explorer.prompts' });

/** Opens (or reveals) the Explorer, optionally seeded with a query and view. */
export async function openExplorer(provider: ExplorerProvider, query?: string, view?: ExplorerView): Promise<void> {
	if (query !== undefined || view) {
		provider.pending = { query: query ?? '', view };
	}
	await vscode.commands.executeCommand('vscode.openWith', EXPLORER_URI, EXPLORER_VIEW_TYPE, { preview: false });
	if (query !== undefined || view) {
		provider.postToAll({ type: 'setQuery', query: query ?? '', view });
	}
}

/** Full-screen, table-first prompt explorer hosted in a webview. One instance per open editor. */
export class ExplorerProvider implements vscode.CustomReadonlyEditorProvider {
	/** Query/view for an editor that is still loading (delivered with its init). */
	pending: { query: string; view?: ExplorerView } | undefined;
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
			}),
		);
		return provider;
	}

	postToAll(msg: ToWebview): void {
		for (const p of this.panels) {
			void p.webview.postMessage(msg);
		}
		// A query delivered to an open Explorer must not leak into the next one opened.
		if (msg.type === 'setQuery' && this.panels.size) {
			this.pending = undefined;
		}
	}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	resolveCustomEditor(_doc: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
		panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
		panel.webview.html = this.html(panel.webview, dist);
		this.panels.add(panel);
		const post = (m: ToWebview) => void panel.webview.postMessage(m);

		const sub = panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
			switch (msg.type) {
				case 'ready': {
					const reducedMotion = vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion') === 'on';
					post({ type: 'init', query: this.pending?.query ?? '', view: this.pending?.view, reducedMotion });
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
				}
			}
		});
		panel.onDidDispose(() => {
			sub.dispose();
			this.panels.delete(panel);
		});
	}

	private html(webview: vscode.Webview, dist: vscode.Uri): string {
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
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
<link rel="stylesheet" href="${style}">
<title>Prompt Explorer</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

/** Backing file system for the Explorer's virtual resource (custom editors need a stat-able URI). */
class EmptyReadonlyFs implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;
	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}
	stat(): vscode.FileStat {
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
	}
	readDirectory(): [string, vscode.FileType][] {
		return [];
	}
	readFile(): Uint8Array {
		return new Uint8Array();
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
