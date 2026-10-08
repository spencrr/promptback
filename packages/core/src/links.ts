import type { SessionInfo, SessionOpenTarget } from './types.js';

export type { SessionOpenTarget };

/** `vscode://agents/agent-host-session/copilotcli/<id>[/chat/<chatId>]` (see vscode `platform/agentHost/common/openSessionLink.ts`). */
export function agentsWindowLink(product: string, agentHostSessionId: string, chatId?: string): string {
	const scheme = product === 'Code - Insiders' ? 'vscode-insiders' : 'vscode';
	const base = `${scheme}://agents/agent-host-session/copilotcli/${encodeURIComponent(agentHostSessionId)}`;
	return chatId ? `${base}/chat/${encodeURIComponent(chatId)}` : base;
}



const EXTERNAL_CLIENTS = new Set(['github/cli', 'github/autopilot']);

/** Ways to reopen/resume the session a prompt came from, best first. */
export function sessionOpenTargets(s: SessionInfo): SessionOpenTarget[] {
	const out: SessionOpenTarget[] = [];
	if (s.source === 'copilot') {
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
		out.push({
			kind: 'terminal-resume',
			label: 'Resume with Copilot CLI',
			command: `copilot --resume ${s.sessionId}`,
			cwd: s.cwd,
		});
	} else {
		out.push({
			kind: 'chat-editor',
			label: 'Open chat session',
			uri: `vscode-chat-session://local/${Buffer.from(s.sessionId).toString('base64url')}`,
			requiresWorkspace: s.workspaceUri,
		});
	}
	return out;
}
