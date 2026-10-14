import * as fs from 'node:fs';
import * as z from 'zod/v4';
import { vscodeUserDataRoots } from '../paths.js';
import type { SessionInfo, SessionOpenTarget } from '../types.js';
import { errorMessage } from '../util/fs.js';
import { baseSourceOptions, type PromptSourcePlugin, type SourceSyncResult } from './base.js';
import { listChatSessionFiles, readChatSession } from './vscodeChat.js';

/** A VS Code product root (`<appData>/<product>`), e.g. `{ product: 'Code', root: '…/Roaming/Code' }`. */
export const vscodeRootSchema = z.object({ product: z.string().min(1), root: z.string().min(1) });

export const vscodeChatSourceOptions = baseSourceOptions.extend({
	/** VS Code user-data roots to read; default: every installed product with data. */
	roots: z.array(vscodeRootSchema).optional(),
});

export type VscodeChatSourceOptions = z.infer<typeof vscodeChatSourceOptions>;

interface ChatFileState {
	readonly size: number;
	readonly mtimeMs: number;
	readonly key: string;
	readonly v?: number;
}

/** VS Code Chat panel history: `User/workspaceStorage/<hash>/chatSessions` mutation logs, replayed whole on change. */
export const vscodeChatSource: PromptSourcePlugin<VscodeChatSourceOptions> = {
	id: 'vscode-chat',
	label: 'VS Code Chat',
	description: 'Chat panel history of every workspace (Stable and Insiders).',
	aliases: ['vscode', 'chat', 'panel'],
	options: vscodeChatSourceOptions,
	clients: [
		{
			id: 'vscode-chat',
			label: 'Chat panel',
			icon: 'comment-discussion',
			color: 'purple',
			aliases: ['chat', 'panel'],
		},
	],

	async sync(o, ctx): Promise<SourceSyncResult> {
		const { store, chunker } = ctx;
		const errors: string[] = [];
		let added = 0;
		let removed = 0;
		let sessionsChanged = false;
		const seen = new Set<string>();
		const states = store.loadFileStates<ChatFileState>('vscode-chat');
		for (const { product, root } of o.roots ?? vscodeUserDataRoots()) {
			for (const file of listChatSessionFiles(product, root)) {
				seen.add(file.path);
				try {
					const st = fs.statSync(file.path);
					const prev = states.get(file.path);
					if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.v === 2) {
						continue;
					}
					const { session, prompts } = readChatSession(file);
					store.transaction(() => {
						if (prompts.length > 0) {
							store.upsertSession(session);
							sessionsChanged = true;
						}
						const [a, r] = store.replaceSessionPrompts(session.key, prompts, chunker);
						added += a;
						removed += r;
						store.setFileState(file.path, 'vscode-chat', {
							size: st.size,
							mtimeMs: st.mtimeMs,
							key: session.key,
							v: 2,
						});
					});
				} catch (e) {
					errors.push(`${file.path}: ${errorMessage(e)}`);
				}
				await ctx.yieldToLoop();
				if (ctx.signal.aborted) {
					return { added, removed, sessionsChanged, errors };
				}
			}
		}
		if (!ctx.retainDeleted) {
			for (const [file, prev] of states) {
				if (!seen.has(file) && !fs.existsSync(file)) {
					removed += store.transaction(() => {
						store.deleteFile(file);
						return prev.key ? store.deleteSession(prev.key) : 0;
					});
				}
			}
		}
		return { added, removed, sessionsChanged, errors };
	},

	openTargets(s: SessionInfo): SessionOpenTarget[] {
		return [
			{
				kind: 'chat-editor',
				label: 'Open chat session',
				uri: `vscode-chat-session://local/${Buffer.from(s.sessionId).toString('base64url')}`,
				requiresWorkspace: s.workspaceUri,
			},
		];
	},
};
