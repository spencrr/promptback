import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostInitOptions } from '@yesterprompt/core';
import { definesServer, vscodeLoadsCopilotConfig } from './copilotMcpConfig.js';

const SERVER_NAME = 'yesterprompt';
const DISCOVERY_SETTING = 'chat.mcp.discovery.enabled';

/**
 * Offers the MCP server to chat in this window; VS Code also forwards it to Agents-window sessions.
 * It is not offered when VS Code itself loads a `yesterprompt` server from Copilot CLI's `mcp-config.json`
 * (set up for Copilot CLI), so the tools don't appear twice.
 */
export function registerMcpServer(context: vscode.ExtensionContext, options: () => HostInitOptions): void {
	// The file VS Code reads (`getCopilotGlobalMcpConfigurationResource`); it ignores `yesterprompt.sources.copilotHome`.
	const copilotConfig = path.join(process.env['COPILOT_HOME'] || path.join(os.homedir(), '.copilot'), 'mcp-config.json');
	const changed = new vscode.EventEmitter<void>();
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(copilotConfig)), 'mcp-config.json'));
	context.subscriptions.push(
		changed,
		watcher,
		watcher.onDidCreate(() => changed.fire()),
		watcher.onDidChange(() => changed.fire()),
		watcher.onDidDelete(() => changed.fire()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('yesterprompt') || e.affectsConfiguration(DISCOVERY_SETTING)) {
				changed.fire();
			}
		}),
		vscode.lm.registerMcpServerDefinitionProvider(SERVER_NAME, {
			onDidChangeMcpServerDefinitions: changed.event,
			provideMcpServerDefinitions: () => {
				if (!vscode.workspace.getConfiguration('yesterprompt').get<boolean>('mcp.enabled', true) || loadedFromCopilotConfig(copilotConfig)) {
					return [];
				}
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

function loadedFromCopilotConfig(file: string): boolean {
	const all = vscode.workspace.getConfiguration();
	if (!vscodeLoadsCopilotConfig(all.inspect(DISCOVERY_SETTING)?.defaultValue, all.get(DISCOVERY_SETTING))) {
		return false;
	}
	try {
		return definesServer(fs.readFileSync(file, 'utf8'), SERVER_NAME);
	} catch {
		return false;
	}
}
