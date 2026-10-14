import { type ChildProcess, fork } from 'node:child_process';
import type { HostEvent, HostInitOptions, HostMethods, HostResponse, SyncProgress, SyncResult } from '@promptback/core';
import * as vscode from 'vscode';

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
}

/**
 * Runs the core engine in a child Node process (VS Code's own runtime via ELECTRON_RUN_AS_NODE) so that model
 * inference and file scanning never block the extension host. Restarts the process if it crashes.
 */
export class HostClient implements vscode.Disposable {
	private child: ChildProcess | undefined;
	private nextId = 1;
	/** In-flight requests, tracked per child so a replaced child's requests are rejected, not leaked. */
	private readonly pending = new Map<ChildProcess, Map<number, Pending>>();
	private initOptions: HostInitOptions | undefined;
	private restarts = 0;
	private disposed = false;

	private readonly _onProgress = new vscode.EventEmitter<SyncProgress>();
	readonly onProgress = this._onProgress.event;
	private readonly _onSynced = new vscode.EventEmitter<SyncResult>();
	readonly onSynced = this._onSynced.event;

	constructor(
		private readonly hostScript: string,
		private readonly log: vscode.LogOutputChannel,
	) {}

	start(options: HostInitOptions): Promise<{ indexDir: string }> {
		this.initOptions = options;
		this.stop();
		this.spawn();
		return this.request('init', options);
	}

	private spawn(): void {
		const child = fork(this.hostScript, [], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			execArgv: [],
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});
		this.child = child;
		this.pending.set(child, new Map());
		child.stdout?.on('data', d => this.log.info(String(d).trimEnd()));
		child.stderr?.on('data', d => this.log.warn(String(d).trimEnd()));
		child.on('message', (msg: HostResponse | HostEvent) => this.onMessage(child, msg));
		child.on('exit', (code, signal) => {
			this.rejectAll(child, new Error(`Prompt index process exited (${code ?? signal})`));
			if (this.child !== child) {
				return;
			}
			this.child = undefined;
			if (!this.disposed && this.initOptions && this.restarts < 5) {
				this.restarts++;
				this.log.error(`Index process exited (${code ?? signal}); restarting (${this.restarts}/5)`);
				setTimeout(() => {
					if (!this.disposed && !this.child) {
						this.spawn();
						this.request('init', this.initOptions!).catch(e => this.log.error(String(e)));
					}
				}, 1000 * this.restarts);
			}
		});
	}

	private onMessage(child: ChildProcess, msg: HostResponse | HostEvent): void {
		if (msg.type === 'res') {
			const map = this.pending.get(child);
			const p = map?.get(msg.id);
			if (!p) {
				return;
			}
			map!.delete(msg.id);
			if ('error' in msg) {
				p.reject(new Error(msg.error));
			} else {
				p.resolve(msg.result);
			}
			return;
		}
		if (child !== this.child) {
			return;
		}
		switch (msg.name) {
			case 'log':
				this.log.info(msg.data);
				break;
			case 'progress':
				this._onProgress.fire(msg.data);
				break;
			case 'synced':
				this.restarts = 0;
				this._onSynced.fire(msg.data);
				break;
		}
	}

	private rejectAll(child: ChildProcess, err: Error): void {
		const map = this.pending.get(child);
		this.pending.delete(child);
		for (const p of map?.values() ?? []) {
			p.reject(err);
		}
	}

	request<M extends keyof HostMethods>(
		method: M,
		params: Parameters<HostMethods[M]>[0],
	): Promise<ReturnType<HostMethods[M]>> {
		const child = this.child;
		const map = child && this.pending.get(child);
		if (!child?.connected || !map) {
			return Promise.reject(new Error('Prompt index process is not running'));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			map.set(id, { resolve: resolve as (v: unknown) => void, reject });
			child.send({ type: 'req', id, method, params }, err => {
				if (err) {
					map.delete(id);
					reject(err);
				}
			});
		});
	}

	/** Asks the child to shut down cleanly (releasing its index lease); force-kills it if it doesn't exit in time. */
	private stop(): void {
		const child = this.child;
		this.child = undefined;
		if (!child) {
			return;
		}
		this.rejectAll(child, new Error('Prompt index process restarted'));
		if (child.connected) {
			child.disconnect();
		}
		const timer = setTimeout(() => child.kill(), 15_000);
		child.once('exit', () => clearTimeout(timer));
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this._onProgress.dispose();
		this._onSynced.dispose();
	}
}
