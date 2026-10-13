import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostInitOptions } from '@yesterprompt/core';
import { definesServer } from './copilotMcpConfig.js';

const SERVER_NAME = 'yesterprompt';

/**
 * Offers the MCP server to chat in this window. VS Code also forwards it to agent-host sessions (the Agents window)
 * without distinguishing session types, and the Copilot runtime behind those sessions loads Copilot CLI's
 * `mcp-config.json` itself. So while that file defines a `yesterprompt` server, offering ours too would give every
 * Copilot session the tools twice: the extension steps aside, whatever `chat.mcp.discovery.enabled` says.
 */
export function registerMcpServer(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, options: () => HostInitOptions): void {
	// The file Copilot reads (`$COPILOT_HOME`, else `~/.copilot`), independent of `yesterprompt.sources.copilotHome`.
	const copilotConfig = path.join(process.env['COPILOT_HOME'] || path.join(os.homedir(), '.copilot'), 'mcp-config.json');
	const changed = new vscode.EventEmitter<void>();
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(copilotConfig)), 'mcp-config.json'));
	let reported: string | undefined;
	const report = (message: string) => {
		if (message !== reported) {
			reported = message;
			log.info(message);
		}
	};
	context.subscriptions.push(
		changed,
		watcher,
		watcher.onDidCreate(() => changed.fire()),
		watcher.onDidChange(() => changed.fire()),
		watcher.onDidDelete(() => changed.fire()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('yesterprompt')) {
				changed.fire();
			}
		}),
		vscode.lm.registerMcpServerDefinitionProvider(SERVER_NAME, {
			onDidChangeMcpServerDefinitions: changed.event,
			provideMcpServerDefinitions: () => {
				if (!vscode.workspace.getConfiguration('yesterprompt').get<boolean>('mcp.enabled', true)) {
					report('MCP server: off (yesterprompt.mcp.enabled is false).');
					return [];
				}
				if (definedInCopilotConfig(copilotConfig)) {
					report(`MCP server: not registered, because ${copilotConfig} defines '${SERVER_NAME}'; Copilot sessions and Copilot CLI use that entry.`);
					return [];
				}
				report('MCP server: registered for chat and agent sessions.');
				// No cwd or version: the Agents window would forward a definition with either only partially.
				return [new vscode.McpStdioServerDefinition('Yesterprompt', process.execPath, [context.asAbsolutePath('dist/mcp.js')], {
					ELECTRON_RUN_AS_NODE: '1',
					// Read by mcpMain.ts.
					YESTERPROMPT_OPTIONS: JSON.stringify(options()),
				})];
			},
		}),
	);
}

function definedInCopilotConfig(file: string): boolean {
	try {
		return definesServer(fs.readFileSync(file, 'utf8'), SERVER_NAME);
	} catch {
		return false;
	}
}
