// biome-ignore-all lint/suspicious/noConsole: the test runner reports on stdout.
// Launches the locally installed VS Code with an isolated profile, loads this extension from source (dist/) and
// runs ./suite.cjs inside the extension host. The prompt index is written to a temp PROMPTBACK_HOME (or one you pass).
// Usage: node test/integration/runTest.mjs [--code <path to Code executable>] [--download] [--index-dir <dir>]
// Without --code, the locally installed VS Code is used when found; --download fetches a stable build into
// .vscode-test/ instead (also the fallback on platforms without a known install location).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, '../..');
const args = process.argv.slice(2);
const arg = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const defaultCode =
	process.platform === 'win32'
		? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')
		: undefined;
const vscodeExecutablePath = args.includes('--download')
	? undefined
	: (arg('--code') ?? (defaultCode && fs.existsSync(defaultCode) ? defaultCode : undefined));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-it-'));
const indexDir = arg('--index-dir') ?? path.join(tmp, 'index');

try {
	await runTests({
		vscodeExecutablePath,
		version: vscodeExecutablePath ? undefined : 'stable',
		extensionDevelopmentPath,
		extensionTestsPath: path.join(here, 'suite.cjs'),
		launchArgs: [
			'--disable-extensions',
			'--user-data-dir',
			path.join(tmp, 'user'),
			'--extensions-dir',
			path.join(tmp, 'ext'),
			'--disable-workspace-trust',
			'--skip-welcome',
		],
		extensionTestsEnv: {
			PROMPTBACK_HOME: indexDir,
			PROMPTBACK_IT: '1',
			PROMPTBACK_IT_HOLD: process.env.PROMPTBACK_IT_HOLD ?? '',
			PROMPTBACK_IT_EXPLORER_HOLD: process.env.PROMPTBACK_IT_EXPLORER_HOLD ?? '',
		},
	});
	console.log('Integration tests passed');
} catch (e) {
	console.error('Integration tests failed', e);
	process.exitCode = 1;
} finally {
	fs.rmSync(path.join(tmp, 'user'), { recursive: true, force: true });
}
