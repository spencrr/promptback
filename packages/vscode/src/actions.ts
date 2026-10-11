import * as vscode from 'vscode';
import type { PromptRecord, SessionInfo } from '@yesterprompt/core';
import { sessionOpenTargets, type SessionOpenTarget } from '@yesterprompt/core/links';
import type { HostClient } from './hostClient.js';

export const PREVIEW_SCHEME = 'yesterprompt-prompt';

export async function copyPrompt(prompt: PromptRecord): Promise<void> {
	await vscode.env.clipboard.writeText(prompt.text);
	vscode.window.setStatusBarMessage(`$(check) Copied prompt (${prompt.text.length.toLocaleString()} chars)`, 3000);
}

/** Pre-fills the chat input without sending (`workbench.action.chat.open` with `isPartialQuery`). Falls back to copying. */
export async function insertIntoChat(prompt: PromptRecord): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt.text, isPartialQuery: true });
	} catch {
		await copyPrompt(prompt);
		void vscode.window.showInformationMessage('Could not insert into chat here — the prompt was copied to the clipboard instead.');
	}
}

export async function previewPrompt(prompt: PromptRecord, session: SessionInfo | undefined): Promise<void> {
	const name = (session?.title ?? prompt.text.split(/\r?\n/, 1)[0] ?? 'prompt').replace(/[\\/:*?"<>|#%\r\n]+/g, ' ').trim().slice(0, 60) || 'prompt';
	const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${name}.md`, query: encodeURIComponent(prompt.id) });
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, { preview: true });
}

export class PromptPreviewProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly host: HostClient) { }

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const id = decodeURIComponent(uri.query);
		const r = await this.host.request('getPrompt', id);
		if (!r) {
			return `Prompt ${id} is no longer in the index.`;
		}
		const { prompt, session: s } = r;
		const meta = [
			s?.title ? `**Session:** ${s.title}` : undefined,
			`**When:** ${new Date(prompt.timestamp).toLocaleString()}`,
			s?.client ? `**Client:** ${s.client}` : undefined,
			s?.repository ? `**Repo:** ${s.repository}${s.branch ? ` (${s.branch})` : ''}` : undefined,
			s?.cwd ? `**Folder:** ${s.cwd}` : undefined,
			prompt.model ? `**Model:** ${prompt.model}` : undefined,
			prompt.origin !== 'human' ? `**Origin:** ${prompt.origin}` : undefined,
			s ? `**Session id:** \`${s.sessionId}\`` : undefined,
			...(s ? sessionOpenTargets(s).filter(t => t.uri && t.kind === 'agents-window').map(t => `**Open:** <${t.uri}>`) : []),
		].filter(Boolean).map(l => `- ${l}`).join('\n');
		return `${meta}\n\n---\n\n${prompt.text}\n`;
	}
}

/** Opens or resumes the originating session, choosing among the available targets. */
export async function openSession(session: SessionInfo): Promise<void> {
	const targets = sessionOpenTargets(session);
	let target: SessionOpenTarget | undefined = targets[0];
	if (targets.length > 1) {
		const pick = await vscode.window.showQuickPick(
			targets.map(t => ({ label: t.label, detail: t.uri ?? t.command, target: t })),
			{ title: `Open session: ${session.title ?? session.sessionId}` },
		);
		target = pick?.target;
	}
	if (!target) {
		return;
	}
	switch (target.kind) {
		case 'agents-window':
			await vscode.env.openExternal(vscode.Uri.parse(target.uri!));
			if (target.bestEffort) {
				vscode.window.setStatusBarMessage('Opening in the Agents window — older CLI sessions may not be listed there; use "Resume with Copilot CLI" instead.', 8000);
			}
			break;
		case 'terminal-resume': {
			const terminal = vscode.window.createTerminal({ name: `Copilot: ${session.title?.slice(0, 30) ?? session.sessionId.slice(0, 8)}`, cwd: target.cwd });
			terminal.show();
			// Typed but not executed, so the user can review it first.
			terminal.sendText(target.command!, false);
			break;
		}
		case 'chat-editor': {
			const ws = target.requiresWorkspace;
			const current = vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
			if (ws && ws !== current) {
				const choice = await vscode.window.showInformationMessage(
					'This chat belongs to another workspace. VS Code can only open it from a window on that workspace.',
					'Open Workspace in New Window',
				);
				if (choice) {
					await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(ws), { forceNewWindow: true });
				}
				return;
			}
			try {
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(target.uri!));
			} catch (e) {
				void vscode.window.showWarningMessage(`Could not open the chat session: ${e instanceof Error ? e.message : e}`);
			}
			break;
		}
	}
}
