import * as fs from 'node:fs';
import * as path from 'node:path';
import * as z from 'zod/v4';
import { copilotHome } from '../paths.js';
import type { SessionInfo, SessionOpenTarget } from '../types.js';
import { errorMessage, mtime } from '../util/fs.js';
import { agentsWindowLink } from './agentHost.js';
import { baseSourceOptions, isShellSafeId, type PromptSourcePlugin, type SourceSyncResult } from './base.js';
import {
	type CopilotFileState,
	copilotSessionKey,
	listCopilotSessions,
	readCopilotEvents,
	readCopilotSessionInfo,
} from './copilot.js';

export const copilotSourceOptions = baseSourceOptions.extend({
	/** Copilot home (`~/.copilot`); default `$COPILOT_HOME`, else `~/.copilot`. */
	home: z.string().min(1).optional(),
});

export type CopilotSourceOptions = z.infer<typeof copilotSourceOptions>;

const EXTERNAL_CLIENTS = new Set(['github/cli', 'github/autopilot']);

/**
 * Copilot sessions (Agents window, Copilot CLI, autopilot): `<home>/session-state/<id>/events.jsonl` read
 * incrementally by byte cursor, plus `workspace.yaml` for session metadata.
 */
export const copilotSource: PromptSourcePlugin<CopilotSourceOptions> = {
	id: 'copilot',
	label: 'Copilot sessions',
	description: 'Agents window, Copilot CLI and autopilot sessions (~/.copilot/session-state).',
	aliases: ['cli', 'agent', 'agents'],
	options: copilotSourceOptions,
	clients: [
		{
			id: 'vscode-agent-host',
			label: 'Agents window',
			icon: 'copilot',
			color: 'blue',
			aliases: ['agent-host', 'agents', 'agent-window'],
		},
		{ id: 'github/cli', label: 'Copilot CLI', icon: 'terminal', color: 'green', aliases: ['cli', 'copilot-cli'] },
		{ id: 'github/autopilot', label: 'Autopilot', icon: 'robot', color: 'orange', aliases: ['autopilot'] },
	],

	async sync(o, ctx): Promise<SourceSyncResult> {
		const home = o.home ?? copilotHome();
		const { store, chunker } = ctx;
		const errors: string[] = [];
		let added = 0;
		let removed = 0;
		let sessionsChanged = false;
		const sessions = listCopilotSessions(home);
		const seen = new Set<string>();
		const eventStates = store.loadFileStates<CopilotFileState>('copilot-events');
		const yamlStates = store.loadFileStates<{ mtimeMs: number; v?: number }>('copilot-yaml');
		for (const [i, s] of sessions.entries()) {
			seen.add(s.eventsPath);
			try {
				const prev = eventStates.get(s.eventsPath);
				const res = readCopilotEvents(s, prev, home);
				const yamlMtime = mtime(s.yamlPath);
				const prevYaml = yamlStates.get(s.yamlPath);
				// v2: session metadata includes derived repositories; re-read every yaml once.
				const yamlChanged = yamlMtime !== prevYaml?.mtimeMs || prevYaml?.v !== 2;
				if (!res && !yamlChanged) {
					continue;
				}
				const hasPrompts = (res?.prompts.length ?? 0) > 0 || (prev?.seq ?? 0) > 0;
				store.transaction(() => {
					if (hasPrompts && (yamlChanged || res)) {
						store.upsertSession(readCopilotSessionInfo(s, res?.state ?? prev, home));
						sessionsChanged = true;
					}
					if (res) {
						if (res.reset && prev) {
							const [a, r] = store.replaceSessionPrompts(
								copilotSessionKey(s.sessionId),
								res.prompts,
								chunker,
							);
							added += a;
							removed += r;
						} else {
							added += store.insertPrompts(res.prompts, chunker);
						}
						store.setFileState(s.eventsPath, 'copilot-events', res.state);
						if (res.oversized) {
							errors.push(`${s.eventsPath}: ${res.oversized} oversized prompt line(s) skipped`);
						}
					}
					store.setFileState(s.yamlPath, 'copilot-yaml', { mtimeMs: yamlMtime, v: 2 });
				});
			} catch (e) {
				errors.push(`${s.eventsPath}: ${errorMessage(e)}`);
			}
			if (i % 25 === 0) {
				await ctx.yieldToLoop();
				if (ctx.signal.aborted) {
					return { added, removed, sessionsChanged, errors };
				}
			}
		}
		if (!ctx.retainDeleted) {
			for (const file of eventStates.keys()) {
				if (!seen.has(file) && !fs.existsSync(file)) {
					const sessionId = path.basename(path.dirname(file));
					removed += store.transaction(() => {
						store.deleteFile(file);
						store.deleteFile(path.join(path.dirname(file), 'workspace.yaml'));
						return store.deleteSession(copilotSessionKey(sessionId));
					});
				}
			}
		}
		return { added, removed, sessionsChanged, errors };
	},

	openTargets(s: SessionInfo): SessionOpenTarget[] {
		const out: SessionOpenTarget[] = [];
		if (s.agentHostSessionId) {
			out.push({
				kind: 'agents-window',
				label: 'Open in Agents window',
				uri: agentsWindowLink(s.product ?? 'Code', s.agentHostSessionId, s.agentHostChatId),
			});
		} else if (s.client && EXTERNAL_CLIENTS.has(s.client)) {
			out.push({
				kind: 'agents-window',
				label: 'Open in Agents window (recent CLI sessions only)',
				uri: agentsWindowLink('Code', s.sessionId),
				bestEffort: true,
			});
		}
		if (isShellSafeId(s.sessionId)) {
			out.push({
				kind: 'terminal-resume',
				label: 'Resume with Copilot CLI',
				command: `copilot --resume ${s.sessionId}`,
				cwd: s.cwd,
			});
		}
		return out;
	},
};
