#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a runner script.
// Runs a TypeScript example against the core sources: bundles it with esbuild into a temp file and executes it.
// Node's own type stripping can't run core directly (TypeScript parameter properties), hence the bundle step.
// Usage: node examples/run.mjs examples/custom-source.ts [args...]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
	console.error('Usage: node examples/run.mjs <example.ts> [args...]');
	process.exit(2);
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-example-')), 'example.mjs');
await esbuild.build({
	absWorkingDir: root,
	entryPoints: [path.resolve(entry)],
	outfile: out,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	external: ['onnxruntime-node'],
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	logLevel: 'warning',
});
try {
	execFileSync(process.execPath, [out, ...args], { stdio: 'inherit' });
} finally {
	fs.rmSync(path.dirname(out), { recursive: true, force: true });
}
