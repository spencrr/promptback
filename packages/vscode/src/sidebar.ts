import * as vscode from 'vscode';
import { type IndexStatus, type RecentSession, sourceCatalog } from '@promptback/core';
import type { HostClient } from './hostClient.js';

/** Sidebar trees in the "Promptback" activity-bar container (main window; the Agents window has no activity bar). */

type SessionNode =
	| { readonly kind: 'group'; readonly label: string; readonly sessions: readonly RecentSession[] }
	| { readonly kind: 'session'; readonly item: RecentSession }
	| { readonly kind: 'prompt'; readonly session: RecentSession; readonly prompt: RecentSession['prompts'][number] };

/** Codicon per client, as declared by the source plugins. */
export function clientIcon(client: string | undefined): string {
	return (client && sourceCatalog().clients[client]?.icon) || 'history';
}

/** Recent sessions grouped by Today / Yesterday / This week / Earlier; expand a session to see its prompts. */
export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionNode> {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private cache: Promise<RecentSession[]> | undefined;

	constructor(private readonly host: HostClient) { }

	refresh(): void {
		this.cache = undefined;
		this.emitter.fire();
	}

	async getChildren(node?: SessionNode): Promise<SessionNode[]> {
		if (!node) {
			this.cache ??= this.host.request('recentSessions', { limit: 60 }).catch(() => []);
			const sessions = await this.cache;
			return groupByRecency(sessions).map(([label, list]) => ({ kind: 'group', label, sessions: list }));
		}
		if (node.kind === 'group') {
			return node.sessions.map(item => ({ kind: 'session', item }));
		}
		if (node.kind === 'session') {
			return [...node.item.prompts].reverse().map(prompt => ({ kind: 'prompt', session: node.item, prompt }));
		}
		return [];
	}

	getTreeItem(node: SessionNode): vscode.TreeItem {
		switch (node.kind) {
			case 'group': {
				const item = new vscode.TreeItem(node.label, node.label === 'Today' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${node.sessions.length}`;
				item.contextValue = 'group';
				return item;
			}
			case 'session': {
				const s = node.item.session;
				const item = new vscode.TreeItem(cleanTitle(s.title) ?? firstLine(node.item.prompts.at(-1)?.preview ?? 'Untitled session'), vscode.TreeItemCollapsibleState.Collapsed);
				const where = s.repository ? `${s.repository}${s.repositoryInferred ? ' (inferred)' : ''}` : s.workspaceless ? 'no folder' : folderName(s.cwd);
				item.description = [where, `${node.item.promptCount} prompt${node.item.promptCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
				item.iconPath = new vscode.ThemeIcon(clientIcon(s.client));
				item.tooltip = new vscode.MarkdownString(`**${escape(s.title ?? 'Untitled session')}**\n\n${escape(where ?? '')} · last active ${new Date(node.item.lastActivity).toLocaleString()}`);
				item.contextValue = 'session';
				item.id = `session:${s.key}`;
				return item;
			}
			case 'prompt': {
				const item = new vscode.TreeItem(firstLine(node.prompt.preview), vscode.TreeItemCollapsibleState.None);
				item.description = relative(node.prompt.timestamp);
				item.tooltip = node.prompt.preview;
				item.iconPath = new vscode.ThemeIcon('comment');
				item.contextValue = 'prompt';
				item.id = `prompt:${node.prompt.id}`;
				item.command = { command: 'promptback.revealPrompt', title: 'Show in Prompt Explorer', arguments: [node] };
				return item;
			}
		}
	}
}

/** Index health at a glance, with the same actions as the Explorer's Index panel. */
export class IndexTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private progress: string | undefined;

	constructor(private readonly host: HostClient) { }

	refresh(progress?: string): void {
		this.progress = progress;
		this.emitter.fire();
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		let s: IndexStatus & { syncing: boolean };
		try {
			s = await this.host.request('status', undefined as never);
		} catch {
			return [row('Starting…', '', 'loading~spin')];
		}
		const pct = s.chunks ? Math.round((s.embeddedChunks / s.chunks) * 100) : 100;
		const rows = [
			row('Prompts', `${s.prompts.toLocaleString()} in ${s.sessions.toLocaleString()} sessions`, 'comment-discussion'),
			row('Semantic', `${pct}% embedded${s.embeddingPaused ? ' (paused)' : ''}`, s.pendingChunks && !s.embeddingPaused ? 'sync~spin' : 'sparkle',
				`${s.embeddedChunks.toLocaleString()} of ${s.chunks.toLocaleString()} chunks embedded`),
			row('Model', s.model ?? 'none', 'symbol-namespace'),
			row('Last scan', s.lastSyncAt ? relative(s.lastSyncAt) : 'never', 'history'),
		];
		if (this.progress) {
			rows.splice(2, 0, row('Working', this.progress, 'loading~spin'));
		}
		if (s.errors.length) {
			rows.push(row('Problems', `${s.errors.length}`, 'warning', s.errors.slice(0, 5).join('\n'), 'promptback.showLog'));
		}
		return rows;
	}

	getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
		return item;
	}
}

function row(label: string, description: string, icon: string, tooltip?: string, command?: string): vscode.TreeItem {
	const item = new vscode.TreeItem(label);
	item.description = description;
	item.iconPath = new vscode.ThemeIcon(icon);
	item.tooltip = tooltip ?? `${label}: ${description}`;
	if (command) {
		item.command = { command, title: label };
	}
	return item;
}

function groupByRecency(sessions: readonly RecentSession[], now = Date.now()): [string, RecentSession[]][] {
	const day = new Date(now);
	const today = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
	const buckets: [string, number][] = [['Today', today], ['Yesterday', today - 86_400_000], ['This week', today - 6 * 86_400_000], ['Earlier', -Infinity]];
	const out = new Map<string, RecentSession[]>();
	for (const s of sessions) {
		const label = buckets.find(([, start]) => s.lastActivity >= start)![0];
		(out.get(label) ?? out.set(label, []).get(label)!).push(s);
	}
	return buckets.map(([l]) => l).filter(l => out.has(l)).map(l => [l, out.get(l)!]);
}

function firstLine(text: string): string {
	const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
	return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Session titles are often the first prompt verbatim: keep its first meaningful line, without markdown markers. */
function cleanTitle(title: string | undefined): string | undefined {
	const line = title?.split(/\r?\n|⏎/).map(l => l.replace(/^[#>*\-\s`]+/, '').replace(/\*\*/g, '').trim()).find(l => l.length > 0);
	return line ? firstLine(line) : undefined;
}

function folderName(cwd: string | undefined): string | undefined {
	return cwd?.split(/[\\/]/).filter(Boolean).at(-1);
}

function escape(s: string): string {
	return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function relative(ts: number): string {
	const s = Math.max(0, (Date.now() - ts) / 1000);
	const steps: [number, string][] = [[31_536_000, 'y'], [2_592_000, 'mo'], [86_400, 'd'], [3_600, 'h'], [60, 'm']];
	for (const [sec, unit] of steps) {
		if (s >= sec) {
			return `${Math.floor(s / sec)}${unit} ago`;
		}
	}
	return 'just now';
}

export type { SessionNode };
