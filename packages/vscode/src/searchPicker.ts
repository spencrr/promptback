import type { PromptOrigin, SearchHit, SearchResult } from '@promptback/core';
import * as vscode from 'vscode';
import { copyPrompt, insertIntoChat, openSession, previewPrompt } from './actions.js';
import type { HostClient } from './hostClient.js';
import { clientIcon } from './sidebar.js';

interface HitItem extends vscode.QuickPickItem {
	readonly hit?: SearchHit;
}

const BTN_COPY: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy prompt' };
const BTN_INSERT: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('comment'),
	tooltip: 'Insert into chat input',
};
const BTN_PREVIEW: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('open-preview'),
	tooltip: 'Show full prompt',
};
const BTN_OPEN: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('link-external'),
	tooltip: 'Open / resume session',
};

const ALL_ORIGINS: PromptOrigin[] = ['human', 'agent', 'skill', 'system', 'autopilot'];

export interface SearchPickerOptions {
	readonly includeAllOrigins?: boolean;
	readonly initialQuery?: string;
	/** Hands the current query over to the full Explorer. */
	readonly onOpenExplorer?: (query: string) => unknown;
}

export function showSearchPicker(host: HostClient, opts: SearchPickerOptions = {}): void {
	const config = vscode.workspace.getConfiguration('promptback');
	const limit = config.get<number>('maxResults', 50);
	let includeAll = Boolean(opts.includeAllOrigins);

	const qp = vscode.window.createQuickPick<HitItem>();
	qp.matchOnDescription = false;
	qp.matchOnDetail = false;
	// Keep our ranking: the setter exists at runtime without the proposed API; ignored if unsupported.
	(qp as unknown as { sortByLabel: boolean }).sortByLabel = false;
	qp.placeholder = 'Search your prompts — e.g. "tree view design doc" repo:PyRIT after:2026-09 client:cli';
	qp.title = 'Promptback';
	qp.keepScrollPosition = false;

	const btnScope = (): vscode.QuickInputButton => ({
		iconPath: new vscode.ThemeIcon(includeAll ? 'filter-filled' : 'filter'),
		tooltip: includeAll
			? 'Showing all messages (agents, skills, system) — click for only your prompts'
			: 'Showing only your prompts — click to include agent/skill/system messages',
	});
	const btnRefresh: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Re-scan now' };
	const btnExplorer: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon('table'),
		tooltip: 'Open in Prompt Explorer (full screen, filters, graph)',
	};
	const buttons = () => [btnScope(), ...(opts.onOpenExplorer ? [btnExplorer] : []), btnRefresh];
	qp.buttons = buttons();

	let seq = 0;
	let timer: NodeJS.Timeout | undefined;
	const run = async (value: string) => {
		const mySeq = ++seq;
		qp.busy = true;
		try {
			const res = await host.request('search', {
				text: value,
				limit,
				filters: { origins: includeAll ? ALL_ORIGINS : undefined },
			});
			if (mySeq !== seq) {
				return;
			}
			qp.items = toItems(res);
			qp.title = titleFor(res, includeAll);
		} catch (e) {
			if (mySeq === seq) {
				qp.items = [
					{
						label: '$(error) Search failed',
						detail: e instanceof Error ? e.message : String(e),
						alwaysShow: true,
					},
				];
			}
		} finally {
			if (mySeq === seq) {
				qp.busy = false;
			}
		}
	};
	const schedule = (value: string, delay = 150) => {
		clearTimeout(timer);
		timer = setTimeout(() => void run(value), delay);
	};

	const disposables: vscode.Disposable[] = [
		qp.onDidChangeValue(v => schedule(v)),
		qp.onDidTriggerButton(b => {
			if (b === btnRefresh) {
				void host.request('sync', { embed: true }).then(
					() => schedule(qp.value, 0),
					() => undefined,
				);
				vscode.window.setStatusBarMessage('$(sync~spin) Re-scanning prompt history…', 3000);
				return;
			}
			if (b === btnExplorer) {
				const value = qp.value;
				qp.hide();
				void opts.onOpenExplorer?.(value);
				return;
			}
			includeAll = !includeAll;
			qp.buttons = buttons();
			schedule(qp.value, 0);
		}),
		qp.onDidTriggerItemButton(async e => {
			const hit = e.item.hit;
			if (!hit) {
				return;
			}
			if (e.button === BTN_COPY) {
				await copyPrompt(hit.prompt);
			} else if (e.button === BTN_INSERT) {
				qp.hide();
				await insertIntoChat(hit.prompt);
			} else if (e.button === BTN_PREVIEW) {
				qp.hide();
				await previewPrompt(hit.prompt, hit.session);
			} else if (e.button === BTN_OPEN) {
				qp.hide();
				await openSession(hit.session);
			}
		}),
		qp.onDidAccept(() => {
			const hit = qp.selectedItems[0]?.hit ?? qp.activeItems[0]?.hit;
			if (!hit) {
				return;
			}
			qp.hide();
			switch (config.get<string>('defaultAction', 'copy')) {
				case 'insert':
					return insertIntoChat(hit.prompt);
				case 'preview':
					return previewPrompt(hit.prompt, hit.session);
				case 'open':
					return openSession(hit.session);
				default:
					return copyPrompt(hit.prompt);
			}
		}),
		qp.onDidHide(() => {
			clearTimeout(timer);
			seq++;
			for (const d of disposables) {
				d.dispose();
			}
			qp.dispose();
		}),
	];

	if (opts.initialQuery) {
		qp.value = opts.initialQuery;
	}
	qp.show();
	void host.request('touch', { maxAgeMs: 30_000 }).catch(() => undefined);
	schedule(qp.value, 0);
}

function titleFor(res: SearchResult, includeAll: boolean): string {
	const parts = [`Promptback — ${res.hits.length} result${res.hits.length === 1 ? '' : 's'}`];
	if (!res.freeText && !res.query.trim()) {
		parts.push('most recent');
	}
	if (res.semanticUnavailable) {
		const why = {
			failed: 'semantic search unavailable',
			pending: 'semantic index warming up',
			off: 'embeddings off',
		};
		parts.push(`keyword only${res.semantic.state === 'ready' ? '' : ` (${why[res.semantic.state]})`}`);
	} else if (res.freeText) {
		parts.push(res.mode);
	}
	if (includeAll) {
		parts.push('all messages');
	}
	parts.push(`${res.tookMs} ms`);
	return parts.join(' · ');
}

function toItems(res: SearchResult): HitItem[] {
	if (res.hits.length === 0) {
		return [
			{
				label: res.query.trim() ? '$(info) No matching prompts' : '$(info) No prompts indexed yet',
				alwaysShow: true,
				detail: 'Try fewer words, remove filters, or run "Promptback: Re-scan and Index Now".',
			},
		];
	}
	return res.hits.map(hit => {
		const s = hit.session;
		const text = hit.prompt.text.trim();
		const firstLine = oneLine(text.split(/\r?\n/u, 1)[0] ?? '', 140);
		const where = [
			s.title && s.title !== firstLine ? oneLine(s.title, 50) : undefined,
			shortRepo(s.repository ?? s.cwd),
			relativeTime(hit.prompt.timestamp),
		]
			.filter(Boolean)
			.join(' · ');
		const extras = [
			hit.duplicates.length > 0 ? `×${hit.duplicates.length + 1}` : undefined,
			hit.prompt.origin === 'human' ? undefined : hit.prompt.origin,
			hit.moreInSession ? `+${hit.moreInSession} more in this session` : undefined,
		]
			.filter(Boolean)
			.join(' · ');
		return {
			label: `${iconFor(s.client)} ${firstLine}`,
			description: where,
			detail: `${extras ? `${extras} — ` : ''}${snippet(text, hit.matchRange, firstLine.length)}`,
			alwaysShow: true,
			buttons: [BTN_COPY, BTN_INSERT, BTN_PREVIEW, BTN_OPEN],
			hit,
		};
	});
}

function iconFor(client: string | undefined): string {
	return `$(${clientIcon(client)})`;
}

function oneLine(s: string, max: number): string {
	const t = s.replace(/\s+/gu, ' ').trim().replace(/\$\(/gu, '$\u200b(');
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A single-line excerpt around the match, skipping the first line already shown as the label. */
function snippet(text: string, range: readonly [number, number] | undefined, labelLen: number): string {
	const width = 220;
	let start = range ? Math.max(0, range[0] - 60) : 0;
	if (!range || range[0] < labelLen) {
		const nl = text.indexOf('\n');
		start = nl > 0 && nl < 400 ? nl + 1 : Math.min(labelLen, text.length);
	}
	const piece = oneLine(text.slice(start, start + width * 2), width);
	return piece ? `${start > 0 ? '…' : ''}${piece}` : '';
}

function shortRepo(r: string | undefined): string | undefined {
	if (!r) {
		return undefined;
	}
	const parts = r.split(/[\\/]/u).filter(Boolean);
	return parts.length > 2 ? parts.slice(-2).join('/') : r;
}

function relativeTime(ts: number): string {
	const s = (Date.now() - ts) / 1000;
	if (s < 60) {
		return 'just now';
	}
	const units: [number, string][] = [
		[60, 'm'],
		[3600, 'h'],
		[86_400, 'd'],
		[86_400 * 30, 'mo'],
		[86_400 * 365, 'y'],
	];
	let out = `${Math.floor(s / 60)}m ago`;
	for (const [sec, u] of units) {
		if (s >= sec) {
			out = `${Math.floor(s / sec)}${u} ago`;
		}
	}
	return out;
}
