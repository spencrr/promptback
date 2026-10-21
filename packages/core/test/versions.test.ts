import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

function read(rel: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Record<string, unknown>;
}

describe('release metadata', () => {
	const manifests = [
		'package.json',
		'packages/core/package.json',
		'packages/cli/package.json',
		'packages/vscode/package.json',
	];

	it('keeps every package and the MCP server manifest on one version', () => {
		const versions = new Set(manifests.map(m => read(m).version));
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
			expect(read(m).license, m).toBe('MIT');
		}
		for (const dir of ['', 'packages/cli', 'packages/vscode']) {
			expect(fs.existsSync(path.join(root, dir, 'LICENSE')), `${dir}/LICENSE`).toBe(true);
		}
	});
});

// `npm ci` must work from the public registry and through an organization's package proxy alike, so the repository
// pins no registry anywhere: not in .npmrc, and not in the lockfile's `resolved` URLs (which npm writes from
// whichever registry served a package, unless told not to).
describe('install metadata', () => {
	it('keeps the committed .npmrc free of registries and credentials, and omits lockfile registry URLs', () => {
		const lines = fs
			.readFileSync(path.join(root, '.npmrc'), 'utf8')
			.split(/\r?\n/)
			.map(l => l.trim())
			.filter(l => l && !l.startsWith(';') && !l.startsWith('#'));
		expect(lines).toContain('omit-lockfile-registry-resolved=true');
		for (const line of lines) {
			const key = line.split('=')[0]!.trim();
			expect(line, 'scoped registry or auth line').not.toMatch(/^(\/\/|@)/);
			expect(
				['registry', 'always-auth', '_auth', '_authToken', 'username', '_password', 'email'],
				line,
			).not.toContain(key);
		}
	});

	it('lets every lockfile entry install from the public registry (no private feed URLs)', () => {
		const lock = read('package-lock.json') as {
			packages: Record<string, { resolved?: string; link?: boolean; integrity?: string }>;
		};
		for (const [name, p] of Object.entries(lock.packages)) {
			// The root, the workspaces themselves and the links to them are local, not fetched.
			if (!name.startsWith('node_modules/') || p.link) {
				continue;
			}
			expect(p.integrity, `${name} has an integrity hash`).toBeDefined();
			if (p.resolved !== undefined) {
				expect(p.resolved, `${name} resolves from a private feed; run npm install --package-lock-only`).toMatch(
					/^https:\/\/registry\.npmjs\.org\//,
				);
			}
		}
	});
});
