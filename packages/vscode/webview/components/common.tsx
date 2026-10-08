/** Small presentational pieces shared by the table, details pane and filters. */
import type { SessionInfo } from '@awss/core/types';
import { CLIENT_ICONS, CLIENT_LABELS, type RepoKind, repoInfo, segments } from '../model.js';

export function Icon({ name, title }: { name: string; title?: string }) {
	return <i class={`codicon codicon-${name}`} title={title} aria-hidden={title ? undefined : 'true'} />;
}

export function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
	return <>{segments(text, terms).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}</>;
}

/** Where the prompt was sent: Agents window, Copilot CLI, Autopilot or Chat panel. */
export function SourcePill({ client }: { client?: string }) {
	const label = CLIENT_LABELS[client ?? ''] ?? client ?? 'Unknown';
	return (
		<span class={`pill source source-${(client ?? 'unknown').replace(/[^a-z]/gi, '')}`} title={label}>
			<Icon name={CLIENT_ICONS[client ?? ''] ?? 'history'} />{label}
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
			{color && <span class="dot" style={{ background: color }} />}
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
