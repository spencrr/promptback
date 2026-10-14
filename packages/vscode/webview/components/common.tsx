/** Small presentational pieces shared by the table, details pane and filters. */
import type { SessionInfo } from '@promptback/core/types';
import { clientInfo, type RepoKind, repoInfo, segments } from '../model.js';

export function Icon({ name, title }: { name: string; title?: string }) {
	return <i class={`codicon codicon-${name}`} title={title} aria-hidden={title ? undefined : 'true'} />;
}

export function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
	// Segments have no identity of their own; their offset in this text is the only stable key.
	let offset = 0;
	return (
		<>
			{segments(text, terms).map(s => {
				const at = offset;
				offset += s.text.length;
				return s.hit ? <mark key={at}>{s.text}</mark> : s.text;
			})}
		</>
	);
}

/** Where the prompt was sent (Agents window, Copilot CLI, Claude Code, ...), tinted with the client's chart colour. */
export function SourcePill({ client }: { client?: string }) {
	const c = clientInfo(client);
	return (
		<span class="pill source" style={{ '--pill-color': `var(--vscode-charts-${c.color})` }} title={c.label}>
			<Icon name={c.icon} />
			{c.label}
		</span>
	);
}

const REPO_ICONS: Record<RepoKind, string> = { repo: 'repo', inferred: 'repo', folder: 'folder', none: 'circle-slash' };
const REPO_TITLES: Record<RepoKind, string> = {
	repo: 'Repository',
	inferred: 'Inferred from the files this session worked on (it was started without a folder)',
	folder: 'Folder (not a git repository)',
	none: 'Started without a folder',
};

/** Repository, folder, inferred repository, or "No folder" — each visibly different. */
export function RepoChip({ session, color }: { session?: SessionInfo; color?: string }) {
	const { label, kind } = repoInfo(session);
	return (
		<span class={`chip repo kind-${kind}`} title={`${REPO_TITLES[kind]}: ${session?.cwd ?? label}`}>
			{color ? <span class="dot" style={{ background: color }} /> : null}
			<Icon name={REPO_ICONS[kind]} />
			<span class="text">{label}</span>
			{kind === 'inferred' && <span class="tag">inferred</span>}
		</span>
	);
}

export function TopicChip({ label, color }: { label: string; color: string }) {
	return (
		<span class="chip topic" title={`Topic: ${label}`}>
			<span class="dot" style={{ background: color }} />
			<span class="text">{label}</span>
		</span>
	);
}
