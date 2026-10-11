import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExploreResult, ExploreRow } from '@yesterprompt/core/types';
import { type DisplayItem, ORIGIN_LABELS, OTHER_COLOR, type SortKey, type ViewModel, type ViewState, relativeTime } from '../model.js';
import type { ColumnKey } from '../vscode.js';
import { Highlighted, Icon, RepoChip, SourcePill, TopicChip } from './common.js';

export const COLUMNS: { key: ColumnKey; label: string; sort?: SortKey; align?: 'right' }[] = [
	{ key: 'prompt', label: 'Prompt', sort: 'relevance' },
	{ key: 'topic', label: 'Topic' },
	{ key: 'session', label: 'Session', sort: 'session' },
	{ key: 'repo', label: 'Repository', sort: 'repo' },
	{ key: 'source', label: 'Source' },
	{ key: 'when', label: 'When', sort: 'time' },
	{ key: 'match', label: 'Match' },
	{ key: 'length', label: 'Length', sort: 'length', align: 'right' },
];
export const DEFAULT_WIDTHS: Record<ColumnKey, number> = { prompt: 420, topic: 170, session: 190, repo: 170, source: 130, when: 84, match: 104, length: 64 };
const ROW_HEIGHT = 30;

export interface TableProps {
	readonly vm: ViewModel;
	readonly result: ExploreResult;
	readonly terms: readonly string[];
	readonly view: ViewState;
	readonly setView: (f: (v: ViewState) => ViewState) => void;
	readonly selectedId?: string;
	readonly select: (id: string) => void;
	readonly hoveredId?: string;
	readonly hover: (id: string | undefined) => void;
	readonly topicColor: ReadonlyMap<number, string>;
	readonly widths: Record<ColumnKey, number>;
	readonly setWidths: (w: Record<ColumnKey, number>) => void;
	readonly onActivate: (id: string) => void;
}

/** Virtualized, sortable, resizable prompt table with optional group headers. */
export function Table(p: TableProps) {
	const { vm, result, view, selectedId } = p;
	const scroller = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [height, setHeight] = useState(600);
	useEffect(() => {
		const el = scroller.current!;
		const ro = new ResizeObserver(() => setHeight(el.clientHeight));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	// Only a new query (not a background index refresh) jumps back to the top.
	useEffect(() => {
		scroller.current?.scrollTo({ top: 0 });
		setScrollTop(0);
	}, [result.query, view.groupBy]);
	// Keep the selection in view when moving with the keyboard.
	useEffect(() => {
		const i = vm.items.findIndex(it => it.kind === 'row' && it.row.id === selectedId);
		const el = scroller.current;
		if (i < 0 || !el) {
			return;
		}
		const top = i * ROW_HEIGHT, bottom = top + ROW_HEIGHT;
		if (top < el.scrollTop + ROW_HEIGHT) {
			el.scrollTop = Math.max(0, top - ROW_HEIGHT);
		} else if (bottom > el.scrollTop + el.clientHeight - ROW_HEIGHT) {
			el.scrollTop = bottom - el.clientHeight + ROW_HEIGHT;
		}
	}, [selectedId]);

	const template = COLUMNS.map(c => `${p.widths[c.key]}px`).join(' ');
	const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10);
	const last = Math.min(vm.items.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 10);
	const maxSim = Math.max(0.0001, ...vm.rows.slice(0, 200).map(r => r.similarity ?? 0));
	const selectedSession = vm.rows.find(r => r.id === selectedId)?.sessionKey;

	const startResize = (key: ColumnKey, e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const x0 = e.clientX, w0 = p.widths[key];
		const onMove = (ev: MouseEvent) => p.setWidths({ ...p.widths, [key]: Math.max(50, w0 + ev.clientX - x0) });
		const onUp = () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	};
	const sortBy = (key?: SortKey) => key && p.setView(v => ({ ...v, sort: key, sortDesc: v.sort === key ? !v.sortDesc : key !== 'repo' && key !== 'session' }));

	// The scroller is always rendered (even when empty) so its ResizeObserver and scroll position stay valid.
	return (
		<div class="table" role="grid" aria-rowcount={vm.rows.length} aria-label="Prompts">
			<div class="thead" role="row" style={{ gridTemplateColumns: template }}>
				{COLUMNS.map(c => (
					<div key={c.key} role="columnheader" class={`th ${c.sort ? 'sortable' : ''} ${c.align ?? ''}`}
						aria-sort={view.sort === c.sort ? (view.sortDesc ? 'descending' : 'ascending') : undefined}
						onClick={() => sortBy(c.sort)}>
						<span>{c.label}</span>
						{view.sort === c.sort && <Icon name={view.sortDesc ? 'arrow-down' : 'arrow-up'} />}
						<span class="resizer" onMouseDown={e => startResize(c.key, e as unknown as MouseEvent)} />
					</div>
				))}
			</div>
			<div class="tbody" ref={scroller} onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)} onMouseLeave={() => p.hover(undefined)}>
				{!vm.rows.length && (
					<div class="empty">{result.freeText ? 'No prompts match. Try fewer words or clear some filters.' : 'No prompts match these filters.'}</div>
				)}
				<div style={{ height: `${vm.items.length * ROW_HEIGHT}px`, position: 'relative' }}>
					{vm.items.slice(first, last).map((item, k) => item.kind === 'group'
						? <GroupHeader key={`g:${item.key}`} item={item} top={(first + k) * ROW_HEIGHT} />
						: <Row key={item.row.id} {...p} row={item.row} top={(first + k) * ROW_HEIGHT} template={template} maxSim={maxSim}
							sameSession={!!selectedSession && item.row.sessionKey === selectedSession && item.row.id !== selectedId} />)}
				</div>
			</div>
		</div>
	);
}

function GroupHeader({ item, top }: { item: Extract<DisplayItem, { kind: 'group' }>; top: number }) {
	return (
		<div class="group-row" role="row" style={{ top: `${top}px` }}>
			{item.color && <span class="dot" style={{ background: item.color }} />}
			<span class="group-label">{item.label}</span>
			<span class="count">{item.count}</span>
		</div>
	);
}

function Row(p: TableProps & { row: ExploreRow; top: number; template: string; maxSim: number; sameSession: boolean }) {
	const { row, result } = p;
	const session = result.sessions[row.sessionKey];
	const selected = row.id === p.selectedId;
	const dups = p.vm.dupCounts.get(row.hash) ?? 1;
	const topic = result.topics.find(t => t.id === row.topic);
	const firstLine = row.preview.trim().split(/\r?\n/, 1)[0] ?? '';
	const classes = ['tr', selected && 'selected', p.sameSession && 'same-session', row.id === p.hoveredId && 'linked', row.origin !== 'human' && 'not-human'];
	return (
		<div role="row" aria-selected={selected} class={classes.filter(Boolean).join(' ')}
			style={{ gridTemplateColumns: p.template, top: `${p.top}px` }}
			onClick={() => p.select(row.id)} onDblClick={() => p.onActivate(row.id)} onMouseEnter={() => p.hover(row.id)}>
			<div role="gridcell" class="td prompt" title={row.preview}>
				{row.origin !== 'human' && <span class={`tag origin-${row.origin}`}>{ORIGIN_LABELS[row.origin]}</span>}
				<span class="text"><Highlighted text={firstLine} terms={p.terms} /></span>
				{dups > 1 && <span class="badge" title={`${dups} identical copies (forks or re-pasted)`}>×{dups}</span>}
			</div>
			<div role="gridcell" class="td">
				{topic ? <TopicChip label={topic.label} color={p.topicColor.get(topic.id) ?? OTHER_COLOR} /> : <span class="muted">—</span>}
			</div>
			<div role="gridcell" class="td" title={session?.title}>
				{session?.forkOf && <span class="fork" title="Forked from another session"><Icon name="repo-forked" /></span>}
				{session?.title ?? <span class="muted">untitled</span>}
			</div>
			<div role="gridcell" class="td"><RepoChip session={session} /></div>
			<div role="gridcell" class="td"><SourcePill client={session?.client} /></div>
			<div role="gridcell" class="td muted" title={new Date(row.timestamp).toLocaleString()}>{relativeTime(row.timestamp)}</div>
			<div role="gridcell" class="td match">
				{row.matchedLexical && <span class="chip lex" title="Contains every search word"><Icon name="whole-word" />words</span>}
				{row.similarity !== undefined && (
					<span class={`sim ${row.matchedSemantic ? 'strong' : ''}`} title={`Semantic similarity ${row.similarity.toFixed(3)}${row.matchedSemantic ? ' (strong)' : ''}`}>
						<span style={{ width: `${Math.max(4, (row.similarity / p.maxSim) * 100)}%` }} />
					</span>
				)}
			</div>
			<div role="gridcell" class="td right muted">{row.length.toLocaleString()}</div>
		</div>
	);
}
