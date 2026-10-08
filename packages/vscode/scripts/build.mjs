// Bundles the extension (extension host) and the index host process (child process) with esbuild.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const common = {
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	sourcemap: production ? false : 'linked',
	minify: production,
	// onnxruntime-node is a native addon shipped next to the bundle; `vscode` is provided by the host.
	external: ['vscode', 'onnxruntime-node'],
	logLevel: 'info',
	absWorkingDir: root,
};

const builds = [
	{ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
	{ ...common, entryPoints: ['../core/src/host.ts'], outfile: 'dist/host.js' },
	{
		...common,
		platform: 'browser',
		format: 'iife',
		target: 'es2022',
		external: [],
		jsx: 'automatic',
		jsxImportSource: 'preact',
		entryPoints: { webview: 'webview/main.tsx' },
		outdir: 'dist',
	},
];

if (watch) {
	for (const b of builds) {
		await (await esbuild.context(b)).watch();
	}
} else {
	await Promise.all(builds.map(b => esbuild.build(b)));
}

// Codicons for the webview (font + stylesheet), as in the official webview-codicons sample.
const codicons = path.dirname(createRequire(import.meta.url).resolve('@vscode/codicons/package.json'));
for (const f of ['codicon.css', 'codicon.ttf']) {
	fs.copyFileSync(path.join(codicons, 'dist', f), path.join(root, 'dist', f));
}
