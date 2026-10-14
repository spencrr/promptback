import type { ExploreResult } from '@promptback/core/types';
import { Fragment } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { PromptAction, ToWebview } from '../../src/explorer/messages.js';
import { ORIGIN_LABELS, relativeTime } from '../model.js';
import { Highlighted, Icon, RepoChip, SourcePill, TopicChip } from './common.js';

type DetailMessage = Extract<ToWebview, { type: 'detail' }>;

/** The selected prompt in full, its actions, and every prompt of its session (with the fork point marked). */
export function Detail({
	detail,
	terms,
	act,
	select,
	result,
	topicColor,
}: {
	detail?: DetailMessage;
	terms: readonly string[];
	act: (a: PromptAction, id?: string) => void;
	select: (id: string) => void;
	result?: ExploreResult;
	topicColor: ReadonlyMap<number, string>;
}) {
	const bodyRef = useRef<HTMLPreElement>(null);
	const stripRef = useRef<HTMLOListElement>(null);
	useEffect(() => {
		bodyRef.current?.querySelector('mark')?.scrollIntoView({ block: 'center' });
		stripRef.current?.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
	}, [detail?.prompt.id]);
	if (!detail) {
		return (
			<aside class="detail empty-detail">
				<Icon name="inspect" />
				Select a prompt to see it in full.
			</aside>
		);
	}
	const { prompt, session: s, sessionPrompts, openTargets } = detail;
	const parent = s?.forkOf ? result?.sessions[s.forkOf] : undefined;
	const row = result?.rows.find(r => r.id === prompt.id);
	const topic = result?.topics.find(t => t.id === row?.topic);
	return (
		<aside class="detail" aria-label="Prompt details">
			<div class="detail-head">
				<h2 title={s?.title}>
					{s?.forkOf ? <Icon name="repo-forked" title="Forked session" /> : null}
					{s?.title ?? 'Untitled session'}
				</h2>
				<div class="meta">
					<SourcePill client={s?.client} />
					<RepoChip session={s} />
					{topic && <TopicChip label={topic.label} color={topicColor.get(topic.id) ?? '#888'} />}
					{prompt.origin !== 'human' && (
						<span class={`tag origin-${prompt.origin}`}>{ORIGIN_LABELS[prompt.origin]}</span>
					)}
				</div>
				<div class="meta muted">
					<span title={new Date(prompt.timestamp).toLocaleString()}>
						<Icon name="clock" />
						{new Date(prompt.timestamp).toLocaleString()}
					</span>
					{s?.branch ? (
						<span>
							<Icon name="git-branch" />
							{s.branch}
						</span>
					) : null}
					{prompt.model ? (
						<span>
							<Icon name="sparkle" />
							{prompt.model}
						</span>
					) : null}
					<span>{prompt.text.length.toLocaleString()} chars</span>
				</div>
				<div class="actions">
					<button type="button" class="primary" onClick={() => act('copy', prompt.id)} title="Copy (Enter)">
						<Icon name="copy" />
						Copy
					</button>
					<button
						type="button"
						onClick={() => act('insert', prompt.id)}
						title="Insert into the chat input without sending (Ctrl+Enter)"
					>
						<Icon name="comment" />
						Insert into chat
					</button>
					<button
						type="button"
						onClick={() => act('open', prompt.id)}
						title={`${openTargets[0]?.label ?? 'Open session'} (O)`}
						disabled={openTargets.length === 0}
					>
						<Icon name="link-external" />
						Open session
					</button>
					<button
						type="button"
						onClick={() => act('preview', prompt.id)}
						title="Open as a read-only document"
					>
						<Icon name="go-to-file" />
						Document
					</button>
				</div>
			</div>
			<pre class="detail-body" ref={bodyRef}>
				<Highlighted text={prompt.text} terms={terms} />
			</pre>
			<div class="session-strip">
				<h3>
					In this session <span class="muted">({sessionPrompts.length})</span>
				</h3>
				<ol ref={stripRef}>
					{sessionPrompts.map(p => (
						<Fragment key={p.id}>
							<li
								class={`${p.id === prompt.id ? 'current' : ''} ${p.origin === 'human' ? '' : 'not-human'}`}
							>
								<button type="button" onClick={() => select(p.id)} title={p.text}>
									<span class="seq">{p.seq + 1}</span>
									<span class="txt">{p.text.trim().split(/\r?\n/, 1)[0]}</span>
									<span class="muted when">{relativeTime(p.timestamp)}</span>
								</button>
							</li>
							{s?.forkPointSeq === p.seq && (
								<li class="fork-point">
									<Icon name="repo-forked" />
									Forked from {parent?.title ? `“${parent.title}”` : 'another session'} — prompts
									below are new
								</li>
							)}
						</Fragment>
					))}
				</ol>
			</div>
		</aside>
	);
}
