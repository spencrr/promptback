#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: an example that prints what it does.
// Talks to `promptback mcp` over stdio the way an agent would: lists the tools, searches, fetches a prompt.
// Needs the built CLI (npm run build -w packages/cli). Pass --no-model to skip the model download.
// Usage: node examples/mcp-client.mjs "retry policy" [--no-model]
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--')) ?? 'design doc';
const cliArgs = [path.join(root, 'packages', 'cli', 'dist', 'cli.js'), 'mcp', ...args.filter(a => a.startsWith('--'))];

const client = new Client({ name: 'example-client', version: '0' });
// MCP clients pass only a safe subset of the environment to servers; forward the index location explicitly, as an
// `env` entry in a client's MCP configuration would.
const env = {
	...getDefaultEnvironment(),
	...(process.env.PROMPTBACK_HOME ? { PROMPTBACK_HOME: process.env.PROMPTBACK_HOME } : {}),
};
await client.connect(new StdioClientTransport({ command: process.execPath, args: cliArgs, env, stderr: 'inherit' }));
try {
	const { tools } = await client.listTools();
	console.log(`Tools: ${tools.map(t => t.name).join(', ')}\n`);
	const text = r => r.content.map(c => c.text).join('\n');
	const found = await client.callTool({ name: 'search_prompts', arguments: { query, limit: 3 } });
	console.log(text(found));
	const id = /prompt: (\S+)/.exec(text(found))?.[1];
	if (id) {
		console.log(`\n--- get_prompt ${id} ---`);
		console.log(text(await client.callTool({ name: 'get_prompt', arguments: { id } })));
	}
} finally {
	await client.close();
}
