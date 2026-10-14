// Bundles the CLI (and the core it depends on) into one ESM file. onnxruntime-node stays external: it is a native
// addon installed next to the CLI as a regular dependency.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

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
	define: { __PROMPTBACK_VERSION__: JSON.stringify(pkg.version) },
	banner: {
		// Bundled CommonJS dependencies expect `require`. (esbuild keeps the entry file's `#!` line above the banner.)
		js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
	},
	logLevel: 'warning',
});

fs.chmodSync(path.join(root, 'dist', 'cli.js'), 0o755);
