// Launches the locally installed VS Code with an isolated profile, loads this extension from source (dist/) and
// runs ./suite.cjs inside the extension host. The prompt index is written to a temp AWSS_HOME (or one you pass).
// Usage: node test/integration/runTest.mjs [--code <path to Code executable>] [--index-dir <dir>]
import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, '../..');
const args = process.argv.slice(2);
const arg = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const defaultCode = process.platform === 'win32'
	? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')
	: undefined;
const vscodeExecutablePath = arg('--code') ?? (defaultCode && fs.existsSync(defaultCode) ? defaultCode : undefined);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awss-it-'));
const indexDir = arg('--index-dir') ?? path.join(tmp, 'index');

try {
	await runTests({
		vscodeExecutablePath,
		version: vscodeExecutablePath ? undefined : 'stable',
		extensionDevelopmentPath,
		extensionTestsPath: path.join(here, 'suite.cjs'),
		launchArgs: ['--disable-extensions', '--user-data-dir', path.join(tmp, 'user'), '--extensions-dir', path.join(tmp, 'ext'), '--disable-workspace-trust', '--skip-welcome'],
		extensionTestsEnv: { AWSS_HOME: indexDir, AWSS_IT: '1', AWSS_IT_HOLD: process.env.AWSS_IT_HOLD ?? '', AWSS_IT_EXPLORER_HOLD: process.env.AWSS_IT_EXPLORER_HOLD ?? '' },
	});
	console.log('Integration tests passed');
} catch (e) {
	console.error('Integration tests failed', e);
	process.exitCode = 1;
} finally {
	fs.rmSync(path.join(tmp, 'user'), { recursive: true, force: true });
}
