import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dominantRoot, isWorkspaceless, listCopilotSessions, readCopilotEvents, readCopilotSessionInfo } from '../src/sources/copilot.js';
import { findGitRoot, gitRootsInText, parseRemote, repoName } from '../src/util/git.js';

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awss-git-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeRepo(name: string, remote?: string): string {
	const root = path.join(tmp, 'src', name);
	fs.mkdirSync(path.join(root, '.git'), { recursive: true });
	fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(root, 'lib', 'a.ts'), '');
	fs.writeFileSync(path.join(root, '.git', 'config'), remote ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '[core]\n');
	return root;
}

describe('git helpers', () => {
	it('parses GitHub, SSH and Azure DevOps remotes', () => {
		expect(parseRemote('https://github.com/microsoft/vscode.git')).toBe('microsoft/vscode');
		expect(parseRemote('git@github.com:spencrr/PyRIT.git')).toBe('spencrr/PyRIT');
		expect(parseRemote('https://dev.azure.com/org/Some%20Project/_git/repo-internal/')).toBe('Some Project/repo-internal');
		expect(parseRemote(undefined)).toBeUndefined();
	});

	it('finds the git root and names it by origin, falling back to the folder name', () => {
		const a = makeRepo('alpha', 'git@github.com:owner/alpha.git');
		const b = makeRepo('beta');
		expect(findGitRoot(path.join(a, 'lib'))).toBe(a);
		expect(repoName(a)).toBe('owner/alpha');
		expect(repoName(b)).toBe('beta');
		expect(gitRootsInText(`Get-Content ${path.join(a, 'lib', 'a.ts')}; cd ${path.join(b, 'missing.txt')}`, tmp, () => false)).toEqual([a, b]);
		expect(gitRootsInText('Resolve-Path "$HOME\\src\\alpha\\lib"', tmp, () => false)).toEqual([a]);
	});

	it('treats ~/.copilot/chats/<id> as workspaceless and needs a clear majority to infer a repo', () => {
		const home = path.join(tmp, '.copilot');
		expect(isWorkspaceless(path.join(home, 'chats', 'abc'), home)).toBe(true);
		expect(isWorkspaceless(path.join(tmp, 'src', 'x'), home)).toBe(false);
		expect(isWorkspaceless(undefined, home)).toBe(false);
		expect(dominantRoot({ a: 5, b: 2 })).toBe('a');
		expect(dominantRoot({ a: 2 })).toBeUndefined();
		expect(dominantRoot({ a: 3, b: 3, c: 3 })).toBeUndefined();
	});

	it('infers the repository of a workspaceless session from its tool calls', () => {
		const repo = makeRepo('gamma', 'https://github.com/owner/gamma');
		const home = path.join(tmp, '.copilot');
		const sid = 'chat-session';
		const dir = path.join(home, 'session-state', sid);
		fs.mkdirSync(dir, { recursive: true });
		const cwd = path.join(home, 'chats', 'c1');
		const ev = (type: string, data: object, id: string) => JSON.stringify({ type, data, id, timestamp: '2026-09-01T00:00:00Z' }) + '\n';
		fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${sid}\ncwd: ${cwd}\nclient_name: vscode-agent-host\n`);
		fs.writeFileSync(path.join(dir, 'events.jsonl'),
			ev('session.start', { context: { cwd } }, 'e0')
			+ ev('user.message', { content: 'fix the bug' }, 'e1')
			+ [1, 2, 3].map(i => ev('tool.execution_start', { toolName: 'view', arguments: { path: path.join(repo, 'lib', 'a.ts') } }, `t${i}`)).join(''));
		const [s] = listCopilotSessions(home);
		const r = readCopilotEvents(s!, undefined, home)!;
		expect(r.state.repoHits).toEqual({ [repo]: 3 });
		const info = readCopilotSessionInfo(s!, r.state, home);
		expect(info).toMatchObject({ repository: 'owner/gamma', repositoryInferred: true, workspaceless: true });

		// Older index state without the scan flag gets backfilled even though the file is unchanged.
		const { repoHits: _h, repoScanned: _s, ...legacy } = r.state;
		const backfilled = readCopilotEvents(s!, legacy, home)!;
		expect(backfilled.prompts).toHaveLength(0);
		expect(backfilled.state.repoHits).toEqual({ [repo]: 3 });
	});
});
