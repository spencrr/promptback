// Builds the MCP App (packages/core/app) into one self-contained HTML string: the Preact UI and its stylesheet,
// inlined, no external requests (the host's CSP allows none by default). The CLI and extension builds embed the
// result into their server bundles as the `__PROMPTBACK_MCP_APP_HTML__` constant; see src/mcpApp.ts.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const core = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * @param {{ minify?: boolean }} [options]
 * @returns {Promise<{ html: string, bytes: number }>}
 */
export async function buildAppHtml({ minify = true } = {}) {
	const result = await esbuild.build({
		absWorkingDir: core,
		entryPoints: ['app/main.tsx'],
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
		target: 'es2022',
		minify,
		jsx: 'automatic',
		jsxImportSource: 'preact',
		outdir: 'app-dist',
		logLevel: 'warning',
	});
	const js = result.outputFiles.find(f => f.path.endsWith('.js'))?.text ?? '';
	const css = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
	// `</script>` inside the bundle would end the inline script early; the standard escape keeps it inert.
	const safeJs = js.replaceAll('</script', '<\\/script');
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Promptback</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${safeJs}</script>
</body>
</html>
`;
	return { html, bytes: Buffer.byteLength(html, 'utf8') };
}
