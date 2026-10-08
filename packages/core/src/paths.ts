import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Mirrors VS Code's `getCopilotHomePath`: `$COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(): string {
	return process.env['COPILOT_HOME'] || path.join(os.homedir(), '.copilot');
}

/** Platform application-data root that contains VS Code's `<product>/User` folders. */
export function appDataRoot(): string {
	if (process.platform === 'win32') {
		return process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming');
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support');
	}
	return process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
}

const KNOWN_PRODUCTS = ['Code', 'Code - Insiders', 'Code - Exploration', 'VSCodium'];

/** Existing VS Code user-data roots (`<appData>/<product>`), stable first. */
export function vscodeUserDataRoots(): { product: string; root: string }[] {
	const base = appDataRoot();
	return KNOWN_PRODUCTS
		.map(product => ({ product, root: path.join(base, product) }))
		.filter(r => isDir(path.join(r.root, 'User')) || isDir(path.join(r.root, 'agentSessionData')));
}

/** Shared, window/profile-independent index directory (the Agents window uses a separate profile, so globalStorage is not shared). */
export function defaultIndexDir(): string {
	if (process.env['AWSS_HOME']) {
		return process.env['AWSS_HOME'];
	}
	if (process.platform === 'win32') {
		return path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'), 'agent-window-semantic-search');
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Caches', 'agent-window-semantic-search');
	}
	return path.join(process.env['XDG_CACHE_HOME'] || path.join(os.homedir(), '.cache'), 'agent-window-semantic-search');
}

export function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}
