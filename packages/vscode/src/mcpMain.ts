// The MCP server process that VS Code starts with its own Node runtime (see mcpProvider.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostInitOptions } from '@promptback/core';
import { serveMcp } from '@promptback/core/mcp';

const options = JSON.parse(process.env['PROMPTBACK_OPTIONS'] || '{}') as HostInitOptions;
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
serveMcp(options, version).catch(e => {
	console.error(e instanceof Error ? e.stack : e);
	process.exit(1);
});
