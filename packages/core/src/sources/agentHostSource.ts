import * as z from 'zod/v4';
import { vscodeUserDataRoots } from '../paths.js';
import { errorMessage, mtime } from '../util/fs.js';
import { type AgentHostDbState, listAgentHostDbs, readAgentHostDb } from './agentHost.js';
import { baseSourceOptions, type PromptSourcePlugin, type SourceSyncResult } from './base.js';
import { vscodeRootSchema } from './vscodeChatSource.js';

export const agentHostSourceOptions = baseSourceOptions.extend({
	/** VS Code user-data roots to read; default: every installed product with data. */
	roots: z.array(vscodeRootSchema).optional(),
});

export type AgentHostSourceOptions = z.infer<typeof agentHostSourceOptions>;

/**
 * Not a prompt source: maps Copilot SDK session ids to Agents-window sessions (`agentSessionData/<id>/session.db`) so
 * Copilot sessions get an "Open in Agents window" link and the window's custom title. Cached by db/wal mtime; a cold
 * read of ~1.4k databases takes seconds.
 */
export const agentHostSource: PromptSourcePlugin<AgentHostSourceOptions> = {
	id: 'agent-host',
	label: 'Agents-window links',
	description: 'Links Copilot sessions to the VS Code Agents-window sessions that wrap them (no prompts of its own).',
	aliases: [],
	options: agentHostSourceOptions,
	clients: [],

	async sync(o, ctx): Promise<SourceSyncResult> {
		const { store } = ctx;
		const errors: string[] = [];
		const links: {
			sdkSessionId: string;
			agentHostSessionId: string;
			product: string;
			chatId?: string;
			title?: string;
		}[] = [];
		let changed = false;
		const seen = new Set<string>();
		const states = store.loadFileStates<AgentHostDbState>('agent-host');
		for (const { product, root } of o.roots ?? vscodeUserDataRoots()) {
			for (const [i, { agentHostSessionId, dbPath }] of listAgentHostDbs(root).entries()) {
				const m = Math.max(mtime(dbPath) ?? -1, mtime(`${dbPath}-wal`) ?? -1);
				if (m < 0) {
					continue;
				}
				seen.add(dbPath);
				let st = states.get(dbPath);
				if (!st || st.mtimeMs !== m) {
					try {
						st = { mtimeMs: m, size: 0, ...readAgentHostDb(dbPath) };
					} catch (e) {
						st = { mtimeMs: m, size: 0, links: [] };
						if (!/no such table/iu.test(errorMessage(e))) {
							errors.push(`${dbPath}: ${errorMessage(e)}`);
						}
					}
					store.setFileState(dbPath, 'agent-host', st);
					changed = true;
				}
				for (const l of st.links) {
					links.push({
						sdkSessionId: l.sdkSessionId,
						agentHostSessionId,
						product,
						chatId: l.chatId,
						title: st.title,
					});
				}
				if (i % 50 === 0) {
					await ctx.yieldToLoop();
					if (ctx.signal.aborted) {
						return { added: 0, removed: 0, sessionsChanged: false, errors };
					}
				}
			}
		}
		for (const file of states.keys()) {
			if (!seen.has(file)) {
				store.deleteFile(file);
				changed = true;
			}
		}
		if (changed) {
			store.transaction(() => store.replaceAgentHostLinks(links));
		}
		return { added: 0, removed: 0, sessionsChanged: changed, errors };
	},
};
