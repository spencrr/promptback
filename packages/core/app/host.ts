/**
 * The app's side of the MCP Apps protocol (https://github.com/modelcontextprotocol/ext-apps, revision 2026-01-26):
 * JSON-RPC over `postMessage` to the host that renders this page. Hand-rolled rather than the `@modelcontextprotocol/
 * ext-apps` client, which is a React-oriented 1.7 MB package pinned to a newer MCP SDK major than the server uses;
 * the subset an app needs is small.
 *
 * Lifecycle: install the message listener, send `ui/initialize`, announce `ui/notifications/initialized`. The host
 * then pushes `ui/notifications/tool-input` and `ui/notifications/tool-result` for the tool call that opened the app
 * (VS Code does so without waiting for `initialized`, hence listener first). Afterwards the app may call the server's
 * tools through the host (`tools/call`), put text into the chat input (`ui/message`; the user still presses send),
 * open links (`ui/open-link`) and report its height (`ui/notifications/size-changed`).
 */

export interface ToolResult {
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
}

export interface HostContext {
	readonly theme?: 'light' | 'dark';
	readonly styles?: { readonly variables?: Record<string, string | undefined> };
	readonly displayMode?: string;
}

export interface HostCapabilities {
	readonly openLinks?: object;
	readonly message?: object;
	readonly updateModelContext?: object;
	readonly serverTools?: object;
}

export interface HostEvents {
	readonly onToolInput?: (args: Record<string, unknown>) => void;
	readonly onToolResult?: (result: ToolResult) => void;
	readonly onHostContext?: (context: HostContext) => void;
}

interface JsonRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

interface JsonRpcNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: unknown;
}

interface JsonRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

type Incoming = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class Host {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	capabilities: HostCapabilities = {};
	context: HostContext = {};

	constructor(private readonly events: HostEvents) {
		// VS Code rehoists `window.parent.postMessage` onto its webview API, so this is the standard transport there
		// and in iframe-based hosts alike.
		window.addEventListener('message', e => this.receive(e.data as Incoming));
	}

	async connect(appInfo: { name: string; version: string }): Promise<void> {
		const result = (await this.request('ui/initialize', {
			protocolVersion: '2026-01-26',
			appInfo,
			appCapabilities: {},
		})) as { hostCapabilities?: HostCapabilities; hostContext?: HostContext };
		this.capabilities = result.hostCapabilities ?? {};
		this.context = result.hostContext ?? {};
		this.events.onHostContext?.(this.context);
		this.notify('ui/notifications/initialized', {});
	}

	callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		return this.request('tools/call', { name, arguments: args }) as Promise<ToolResult>;
	}

	/** Puts `text` into the chat input for the user to edit and send; false when the host declined (input not empty). */
	async insertIntoChat(text: string): Promise<boolean> {
		const r = (await this.request('ui/message', { role: 'user', content: [{ type: 'text', text }] })) as {
			isError?: boolean;
		};
		return r.isError !== true;
	}

	openLink(url: string): Promise<unknown> {
		return this.request('ui/open-link', { url });
	}

	sizeChanged(height: number): void {
		this.notify('ui/notifications/size-changed', { height });
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: '2.0', method, params });
	}

	private send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
		window.parent.postMessage(message, '*');
	}

	private receive(message: Incoming): void {
		if (!message || typeof message !== 'object' || !('jsonrpc' in message)) {
			return;
		}
		if ('method' in message) {
			const params = (message.params ?? {}) as Record<string, unknown>;
			switch (message.method) {
				case 'ui/notifications/tool-input':
					this.events.onToolInput?.((params.arguments ?? {}) as Record<string, unknown>);
					break;
				case 'ui/notifications/tool-result':
					this.events.onToolResult?.(params as ToolResult);
					break;
				case 'ui/notifications/host-context-changed':
					this.context = { ...this.context, ...(params as HostContext) };
					this.events.onHostContext?.(this.context);
					break;
				case 'ping':
					if ('id' in message) {
						this.send({ jsonrpc: '2.0', id: message.id, result: {} });
					}
					break;
				default:
					// Requests the app does not implement get a method-not-found reply, notifications are ignored.
					if ('id' in message) {
						this.send({
							jsonrpc: '2.0',
							id: message.id,
							error: { code: -32_601, message: `Method not found: ${message.method}` },
						});
					}
			}
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message));
		} else {
			pending.resolve(message.result);
		}
	}
}
