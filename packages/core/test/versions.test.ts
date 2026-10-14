import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

function read(rel: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Record<string, unknown>;
}

describe('release metadata', () => {
	const manifests = ['package.json', 'packages/core/package.json', 'packages/cli/package.json', 'packages/vscode/package.json'];

	it('keeps every package and the MCP server manifest on one version', () => {
		const versions = new Set(manifests.map(m => read(m)['version']));
		const server = read('packages/cli/server.json') as { version: string; packages: { version: string }[] };
		versions.add(server.version);
		for (const p of server.packages) {
			versions.add(p.version);
		}
		expect([...versions]).toHaveLength(1);
		expect([...versions][0]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('names the MCP server consistently in server.json and the npm package', () => {
		const server = read('packages/cli/server.json') as { name: string; packages: { identifier: string }[] };
		const cli = read('packages/cli/package.json') as { name: string; mcpName: string; bin: Record<string, string> };
		expect(cli.mcpName).toBe(server.name);
		expect(server.packages.map(p => p.identifier)).toEqual([cli.name]);
		expect(Object.keys(cli.bin)).toEqual([cli.name]);
	});

	it('declares a license in every manifest and ships the LICENSE file with each artifact', () => {
		for (const m of manifests) {
			expect(read(m)['license'], m).toBe('MIT');
		}
		for (const dir of ['', 'packages/cli', 'packages/vscode']) {
			expect(fs.existsSync(path.join(root, dir, 'LICENSE')), `${dir}/LICENSE`).toBe(true);
		}
	});
});
