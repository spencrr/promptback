// biome-ignore-all lint/suspicious/noConsole: build scripts report progress on stdout.
// Bundles the CLI (and the core it depends on) into one ESM file. onnxruntime-node stays external: it is a native
// addon installed next to the CLI as a regular dependency.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildAppHtml } from '../../core/scripts/buildApp.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// The MCP App served by promptback mcp, embedded as a string so the binary stays one file.
const app = await buildAppHtml();

await esbuild.build({
	absWorkingDir: root,
	entryPoints: ['src/cli.ts'],
	outfile: 'dist/cli.js',
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	external: ['onnxruntime-node'],
	// Bundled dependencies keep their license headers at the end of the file.
	legalComments: 'eof',
	define: {
		// biome-ignore lint/style/useNamingConvention: compile-time constant, named like one.
		__PROMPTBACK_VERSION__: JSON.stringify(pkg.version),
		// biome-ignore lint/style/useNamingConvention: compile-time constant, named like one.
		__PROMPTBACK_MCP_APP_HTML__: JSON.stringify(app.html),
	},
	banner: {
		// Bundled CommonJS dependencies expect `require`. (esbuild keeps the entry file's `#!` line above the banner.)
		js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
	},
	logLevel: 'warning',
});

fs.chmodSync(path.join(root, 'dist', 'cli.js'), 0o755);
console.log(`dist/cli.js (MCP app ${(app.bytes / 1024).toFixed(1)} KB embedded)`);
