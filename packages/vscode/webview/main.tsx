import './styles.css';
import { Fragment, render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ExploreResult, ExploreRow, SessionInfo } from '@awss/core/types';
import type { FromWebview, PromptAction, ToWebview } from '../src/explorer/messages.js';
import { ConstellationGraph } from './graph.js';
import {
	CLIENT_LABELS, DEFAULT_VIEW, type FacetKey, ORIGIN_LABELS, type SortKey, type ViewModel, type ViewState, buildGraph, computeView,
	highlightTerms, histogram, relativeTime, repoLabel, segments,
} from './model.js';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): Persisted | undefined; setState(s: Persisted): void };

interface Persisted {
	query: string;
	view: ViewState;
	mode: 'table' | 'graph';
	selectedId?: string;
	widths: Record<ColumnKey, number>;
}

const vscode = acquireVsCodeApi();
const saved = vscode.getState();

type ColumnKey = 'prompt' | 'session' | 'repo' | 'source' | 'when' | 'match' | 'length';
const COLUMNS: { key: ColumnKey; label: string; sort?: SortKey; align?: 'right' }[] = [
	{ key: 'prompt', label: 'Prompt', sort: 'relevance' },
	{ key: 'session', label: 'Session', sort: 'session' },
	{ key: 'repo', label: 'Repository', sort: 'repo' },
	{ key: 'source', label: 'Source' },
	{ key: 'when', label: 'When', sort: 'time' },
	{ key: 'match', label: 'Match' },
	{ key: 'length', label: 'Length', sort: 'length', align: 'right' },
];
const DEFAULT_WIDTHS: Record<ColumnKey, number> = { prompt: 440, session: 200, repo: 150, source: 110, when: 90, match: 110, length: 70 };
const ROW_HEIGHT = 28;

function useRpc() {
	const next = useRef(1);
	const latest = useRef<Record<string, number>>({});
	return {
		/** Returns a request id and marks it as the latest for `channel` (older responses are dropped). */
		begin(channel: string): number {
			const id = next.current++;
			latest.current[channel] = id;
			return id;
		},
		isLatest: (channel: string, id: number) => latest.current[channel] === id,
	};
}

function App() {
	const [query, setQuery] = useState(saved?.query ?? '');
	const [result, setResult] = useState<ExploreResult>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [view, setView] = useState<ViewState>(saved?.view ?? DEFAULT_VIEW);
	const [mode, setMode] = useState<'table' | 'graph'>(saved?.mode ?? 'table');
	const [selectedId, setSelectedId] = useState<string | undefined>(saved?.selectedId);
	const [detail, setDetail] = useState<Extract<ToWebview, { type: 'detail' }>>();
	const [widths, setWidths] = useState<Record<ColumnKey, number>>(saved?.widths ?? DEFAULT_WIDTHS);
	const [reducedMotion, setReducedMotion] = useState(false);
	const [showHelp, setShowHelp] = useState(false);
	const [showFilters, setShowFilters] = useState(() => window.innerWidth > 980);
	const rpc = useRpc();
	const queryRef = useRef(query);
	queryRef.current = query;
	const inputRef = useRef<HTMLInputElement>(null);

	const runQuery = useCallback((text: string) => {
		const id = rpc.begin('query');
		setLoading(true);
		vscode.postMessage({ type: 'query', requestId: id, text });
	}, []);

	useEffect(() => {
		const onMessage = (e: MessageEvent<ToWebview>) => {
			const m = e.data;
			switch (m.type) {
				case 'init':
					setReducedMotion(m.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
					if (m.view) {
						setMode(m.view);
					}
					if (m.query) {
						setQuery(m.query);
					}
					runQuery(m.query || queryRef.current);
					break;
				case 'setQuery':
					if (m.view) {
						setMode(m.view);
					}
					setQuery(m.query);
					runQuery(m.query);
					inputRef.current?.focus();
					break;
				case 'result':
					if (rpc.isLatest('query', m.requestId)) {
						setResult(m.result);
						setError(undefined);
						setLoading(false);
					}
					break;
				case 'error':
					if (rpc.isLatest('query', m.requestId)) {
						setError(m.message);
						setLoading(false);
					}
					break;
				case 'detail':
					if (rpc.isLatest('detail', m.requestId)) {
						setDetail(m);
					}
					break;
				case 'indexChanged':
					runQuery(queryRef.current);
					break;
			}
		};
		window.addEventListener('message', onMessage);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	// Debounced search as you type.
	const firstRun = useRef(true);
	useEffect(() => {
		if (firstRun.current) {
			firstRun.current = false;
			return;
		}
		const t = setTimeout(() => runQuery(query), 180);
		return () => clearTimeout(t);
	}, [query]);

	useEffect(() => vscode.setState({ query, view, mode, selectedId, widths }), [query, view, mode, selectedId, widths]);

	const vm = useMemo(() => (result ? computeView(result, view) : undefined), [result, view]);

	// Keep a valid selection and fetch its full text.
	useEffect(() => {
		if (!vm) {
			return;
		}
		if (!selectedId || !vm.rows.some(r => r.id === selectedId)) {
			if (vm.rows[0] && (!selectedId || !detail || detail.prompt.id !== selectedId)) {
				setSelectedId(vm.rows[0].id);
			}
		}
	}, [vm]);
	useEffect(() => {
		if (!selectedId) {
			setDetail(undefined);
			return;
		}
		const t = setTimeout(() => vscode.postMessage({ type: 'detail', requestId: rpc.begin('detail'), promptId: selectedId }), 60);
		return () => clearTimeout(t);
	}, [selectedId]);

	const act = useCallback((action: PromptAction, id = selectedId) => {
		if (id) {
			vscode.postMessage({ type: 'action', action, promptId: id });
		}
	}, [selectedId]);

	const move = useCallback((delta: number) => {
		if (!vm?.rows.length) {
			return;
		}
		const i = vm.rows.findIndex(r => r.id === selectedId);
		const next = vm.rows[Math.max(0, Math.min(vm.rows.length - 1, (i < 0 ? 0 : i) + delta))]!;
		setSelectedId(next.id);
	}, [vm, selectedId]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const inSearch = target === inputRef.current;
			// Leave keys alone on buttons, checkboxes, links and other inputs so they keep working with the keyboard.
			const onControl = !inSearch && !!target.closest('button, a, input, select, textarea, [role="dialog"]');
			if (onControl) {
				return;
			}
			if (e.key === '/' && !inSearch) {
				e.preventDefault();
				inputRef.current?.focus();
				inputRef.current?.select();
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				move(e.key === 'ArrowDown' ? 1 : -1);
			} else if (e.key === 'PageDown' || e.key === 'PageUp') {
				e.preventDefault();
				move(e.key === 'PageDown' ? 15 : -15);
			} else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				act('insert');
			} else if (e.key === 'Enter') {
				e.preventDefault();
				act('copy');
			} else if (!inSearch && e.key.toLowerCase() === 'o') {
				act('open');
			} else if (!inSearch && e.key.toLowerCase() === 'g') {
				setMode(m => (m === 'graph' ? 'table' : 'graph'));
			} else if (e.key === 'Escape' && inSearch && query) {
				setQuery('');
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [move, act, query]);

	const terms = useMemo(() => highlightTerms(result?.freeText ?? ''), [result]);
	const toggleFacet = (key: FacetKey, value: string) => setView(v => {
		const cur = v.facets[key];
		const next = cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value];
		return { ...v, facets: { ...v.facets, [key]: next } };
	});
	const activeFilters = view.facets.origin.length + view.facets.client.length + view.facets.repo.length + (view.dateRange ? 1 : 0);

	return (
		<div class={`app ${showFilters ? '' : 'no-rail'}`}>
			<header class="topbar">
				<div class="search">
					<span class="codicon-search" aria-hidden="true">⌕</span>
					<input
						ref={inputRef}
						value={query}
						onInput={e => setQuery((e.target as HTMLInputElement).value)}
						placeholder='Search your prompts — try "tree view design doc" repo:PyRIT after:2026-09'
						aria-label="Search prompts"
						autofocus
						spellcheck={false}
					/>
					{loading && <span class="spinner" aria-label="Searching" />}
					<button class="icon" title="Query syntax" aria-expanded={showHelp} onClick={() => setShowHelp(s => !s)}>?</button>
				</div>
				<div class="summary" aria-live="polite">
					{vm && <Summary vm={vm} result={result!} />}
				</div>
				<div class="toolbar">
					<button class={`toggle ${showFilters ? 'on' : ''}`} onClick={() => setShowFilters(s => !s)} title="Show or hide filters">
						Filters{activeFilters ? ` (${activeFilters})` : ''}
					</button>
					<label class="check"><input type="checkbox" checked={view.hideDuplicates} onChange={() => setView(v => ({ ...v, hideDuplicates: !v.hideDuplicates }))} />Hide duplicates</label>
					<div class="segmented" role="tablist" aria-label="View">
						<button role="tab" aria-selected={mode === 'table'} class={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>Table</button>
						<button role="tab" aria-selected={mode === 'graph'} class={mode === 'graph' ? 'on' : ''} onClick={() => setMode('graph')} title="Constellation view (G)">Graph</button>
					</div>
				</div>
				{showHelp && <Help onClose={() => setShowHelp(false)} />}
			</header>

			{showFilters && vm && <FacetRail vm={vm} view={view} toggle={toggleFacet} setView={setView} />}

			<main class="center">
				{error && <div class="banner error">Search failed: {error}</div>}
				{result?.semanticUnavailable && <div class="banner">Semantic search is warming up — showing keyword matches for now.</div>}
				{vm && mode === 'table' && (
					<Table vm={vm} result={result!} terms={terms} view={view} setView={setView} selectedId={selectedId} select={setSelectedId}
						widths={widths} setWidths={setWidths} onActivate={id => act('copy', id)} />
				)}
				{vm && mode === 'graph' && (
					<GraphView vm={vm} result={result!} selectedId={selectedId} select={setSelectedId} reducedMotion={reducedMotion}
						onActivate={id => act('copy', id)} />
				)}
				{!vm && <div class="empty">Loading your prompt history…</div>}
			</main>

			<Detail detail={detail} terms={terms} act={act} select={setSelectedId} result={result} />
		</div>
	);
}

function Summary({ vm, result }: { vm: ViewModel; result: ExploreResult }) {
	const shown = vm.rows.length;
	const what = result.freeText ? `${shown.toLocaleString()} matching prompt${shown === 1 ? '' : 's'}` : `${shown.toLocaleString()} prompts`;
	const hidden = vm.totalMatches - shown;
	return <span>{what}{hidden > 0 ? <span class="muted"> · {hidden.toLocaleString()} filtered or duplicate</span> : null}<span class="muted"> · {result.tookMs} ms</span></span>;
}

function FacetRail({ vm, view, toggle, setView }: {
	vm: ViewModel; view: ViewState; toggle: (k: FacetKey, v: string) => void; setView: (f: (v: ViewState) => ViewState) => void;
}) {
	const sections: { key: FacetKey; title: string; label: (v: string) => string; limit: number }[] = [
		{ key: 'origin', title: 'Author', label: v => ORIGIN_LABELS[v as keyof typeof ORIGIN_LABELS] ?? v, limit: 10 },
		{ key: 'client', title: 'Source', label: v => CLIENT_LABELS[v] ?? v, limit: 10 },
		{ key: 'repo', title: 'Repository', label: v => v, limit: 12 },
	];
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const any = view.facets.origin.length || view.facets.client.length || view.facets.repo.length || view.dateRange || !view.hideAcks;
	return (
		<aside class="rail" aria-label="Filters">
			<div class="rail-head">
				<span>Filters</span>
				{any ? <button class="link" onClick={() => setView(v => ({ ...v, facets: { origin: [], client: [], repo: [] }, dateRange: undefined, hideAcks: true }))}>Clear all</button> : null}
			</div>
			<section>
				<h3>When</h3>
				<Histogram timestamps={vm.timeline} range={view.dateRange} setRange={r => setView(v => ({ ...v, dateRange: r }))} />
			</section>
			{sections.map(s => {
				const values = vm.facets[s.key];
				const max = Math.max(1, ...values.map(v => v.count));
				const shown = expanded[s.key] ? values : values.slice(0, s.limit);
				return (
					<section key={s.key}>
						<h3>{s.title}</h3>
						<ul>
							{shown.map(v => (
								<li key={v.value}>
									<label class={`facet ${v.count === 0 ? 'zero' : ''}`} title={v.value}>
										<input type="checkbox" checked={view.facets[s.key].includes(v.value)} onChange={() => toggle(s.key, v.value)} />
										<span class="name">{s.label(v.value)}</span>
										<span class="bar" style={{ width: `${(v.count / max) * 100}%` }} />
										<span class="count">{v.count}</span>
									</label>
								</li>
							))}
						</ul>
						{values.length > s.limit && (
							<button class="link" onClick={() => setExpanded(e => ({ ...e, [s.key]: !e[s.key] }))}>
								{expanded[s.key] ? 'Show fewer' : `Show all ${values.length}`}
							</button>
						)}
					</section>
				);
			})}
			<section>
				<label class="check"><input type="checkbox" checked={!view.hideAcks} onChange={() => setView(v => ({ ...v, hideAcks: !v.hideAcks }))} />Include short replies ("continue", "yes")</label>
			</section>
		</aside>
	);
}

/** Clickable/brushable date histogram. Drag to select a range; click a bar for that bucket; click outside to clear. */
function Histogram({ timestamps, range, setRange }: { timestamps: readonly number[]; range?: readonly [number, number]; setRange: (r?: [number, number]) => void }) {
	const buckets = useMemo(() => histogram(timestamps), [timestamps]);
	const [drag, setDrag] = useState<[number, number]>();
	if (!buckets.length) {
		return <div class="muted small">No dates</div>;
	}
	const max = Math.max(...buckets.map(b => b.count));
	const W = 200, H = 48, bw = W / buckets.length;
	const idx = (e: MouseEvent) => {
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		return Math.max(0, Math.min(buckets.length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * buckets.length)));
	};
	const sel = drag ? [Math.min(...drag), Math.max(...drag)] : undefined;
	const inRange = (i: number) => sel ? i >= sel[0]! && i <= sel[1]! : range ? buckets[i]!.start >= range[0] && buckets[i]!.end <= range[1] : true;
	const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
	return (
		<div class="histogram">
			<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Prompts over time; drag to filter"
				onMouseDown={e => setDrag([idx(e), idx(e)])}
				onMouseMove={e => drag && setDrag([drag[0], idx(e)])}
				onMouseUp={() => {
					if (sel) {
						setRange([buckets[sel[0]!]!.start, buckets[sel[1]!]!.end]);
					}
					setDrag(undefined);
				}}
				onMouseLeave={() => setDrag(undefined)}>
				{buckets.map((b, i) => {
					const h = b.count ? Math.max(2, (b.count / max) * (H - 2)) : 0;
					return <rect key={b.start} x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1)} height={h} class={inRange(i) ? 'in' : 'out'}><title>{`${fmt(b.start)}: ${b.count}`}</title></rect>;
				})}
			</svg>
			<div class="axis">
				<span>{fmt(range?.[0] ?? buckets[0]!.start)}</span>
				{range ? <button class="link" onClick={() => setRange(undefined)}>Any time</button> : null}
				<span>{fmt(range ? range[1] - 1 : buckets[buckets.length - 1]!.end - 1)}</span>
			</div>
		</div>
	);
}

function Table({ vm, result, terms, view, setView, selectedId, select, widths, setWidths, onActivate }: {
	vm: ViewModel; result: ExploreResult; terms: string[]; view: ViewState; setView: (f: (v: ViewState) => ViewState) => void;
	selectedId?: string; select: (id: string) => void; widths: Record<ColumnKey, number>; setWidths: (w: Record<ColumnKey, number>) => void;
	onActivate: (id: string) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [height, setHeight] = useState(600);
	useEffect(() => {
		const el = scroller.current!;
		const ro = new ResizeObserver(() => setHeight(el.clientHeight));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	useEffect(() => {
		scroller.current?.scrollTo({ top: 0 });
		setScrollTop(0);
	}, [result.query]);
	// Keep the selection in view when moving with the keyboard.
	useEffect(() => {
		const i = vm.rows.findIndex(r => r.id === selectedId);
		const el = scroller.current;
		if (i < 0 || !el) {
			return;
		}
		const top = i * ROW_HEIGHT, bottom = top + ROW_HEIGHT;
		if (top < el.scrollTop) {
			el.scrollTop = top;
		} else if (bottom > el.scrollTop + el.clientHeight - ROW_HEIGHT) {
			el.scrollTop = bottom - el.clientHeight + ROW_HEIGHT;
		}
	}, [selectedId]);

	const template = COLUMNS.map(c => `${widths[c.key]}px`).join(' ');
	const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10);
	const last = Math.min(vm.rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 10);
	const maxSim = Math.max(0.0001, ...vm.rows.slice(0, 200).map(r => r.similarity ?? 0));

	const startResize = (key: ColumnKey, e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const x0 = e.clientX, w0 = widths[key];
		const onMove = (ev: MouseEvent) => setWidths({ ...widths, [key]: Math.max(50, w0 + ev.clientX - x0) });
		const onUp = () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	};
	const sortBy = (key?: SortKey) => key && setView(v => ({ ...v, sort: key, sortDesc: v.sort === key ? !v.sortDesc : key !== 'repo' && key !== 'session' }));

	// The scroller is always rendered (even when empty) so its ResizeObserver and scroll position stay valid.
	return (
		<div class="table" role="grid" aria-rowcount={vm.rows.length} aria-label="Prompts">
			<div class="thead" role="row" style={{ gridTemplateColumns: template }}>
				{COLUMNS.map(c => (
					<div key={c.key} role="columnheader" class={`th ${c.sort ? 'sortable' : ''} ${c.align ?? ''}`}
						aria-sort={view.sort === c.sort ? (view.sortDesc ? 'descending' : 'ascending') : undefined}
						onClick={() => sortBy(c.sort)}>
						<span>{c.label}{view.sort === c.sort ? (view.sortDesc ? ' ↓' : ' ↑') : ''}</span>
						<span class="resizer" onMouseDown={e => startResize(c.key, e as unknown as MouseEvent)} />
					</div>
				))}
			</div>
			<div class="tbody" ref={scroller} onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
				{!vm.rows.length && (
					<div class="empty">{result.freeText ? 'No prompts match. Try fewer words or clear some filters.' : 'No prompts match these filters.'}</div>
				)}
				<div style={{ height: `${vm.rows.length * ROW_HEIGHT}px`, position: 'relative' }}>
					{vm.rows.slice(first, last).map((r, k) => (
						<Row key={r.id} row={r} index={first + k} session={result.sessions[r.sessionKey]} template={template} terms={terms}
							dups={vm.dupCounts.get(r.hash) ?? 1} selected={r.id === selectedId} maxSim={maxSim}
							onClick={() => select(r.id)} onDblClick={() => onActivate(r.id)} />
					))}
				</div>
			</div>
		</div>
	);
}

function Row({ row, index, session, template, terms, dups, selected, maxSim, onClick, onDblClick }: {
	row: ExploreRow; index: number; session?: SessionInfo; template: string; terms: string[]; dups: number; selected: boolean; maxSim: number;
	onClick: () => void; onDblClick: () => void;
}) {
	const firstLine = row.preview.trim().split(/\r?\n/, 1)[0] ?? '';
	return (
		<div role="row" aria-selected={selected} class={`tr ${selected ? 'selected' : ''} ${row.origin !== 'human' ? 'not-human' : ''}`}
			style={{ gridTemplateColumns: template, top: `${index * ROW_HEIGHT}px` }} onClick={onClick} onDblClick={onDblClick}>
			<div role="gridcell" class="td prompt" title={row.preview}>
				{row.origin !== 'human' && <span class="tag">{ORIGIN_LABELS[row.origin]}</span>}
				<span class="text"><Highlighted text={firstLine} terms={terms} /></span>
				{dups > 1 && <span class="badge" title={`${dups} identical copies (forks or re-pasted)`}>×{dups}</span>}
			</div>
			<div role="gridcell" class="td" title={session?.title}>
				{session?.forkOf && <span class="fork" title="Forked session">⑂</span>}{session?.title ?? <span class="muted">untitled</span>}
			</div>
			<div role="gridcell" class="td muted" title={session?.repository ?? session?.cwd}>{repoLabel(session)}</div>
			<div role="gridcell" class="td muted">{CLIENT_LABELS[session?.client ?? ''] ?? session?.client ?? ''}</div>
			<div role="gridcell" class="td muted" title={new Date(row.timestamp).toLocaleString()}>{relativeTime(row.timestamp)}</div>
			<div role="gridcell" class="td match">
				{row.matchedLexical && <span class="chip lex" title="Contains every search word">words</span>}
				{row.similarity !== undefined && (
					<span class={`sim ${row.matchedSemantic ? 'strong' : ''}`} title={`Semantic similarity ${row.similarity.toFixed(3)}`}>
						<span style={{ width: `${Math.max(4, (row.similarity / maxSim) * 100)}%` }} />
					</span>
				)}
			</div>
			<div role="gridcell" class="td right muted">{row.length.toLocaleString()}</div>
		</div>
	);
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
	return <>{segments(text, terms).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}</>;
}

function Detail({ detail, terms, act, select, result }: {
	detail?: Extract<ToWebview, { type: 'detail' }>; terms: string[]; act: (a: PromptAction, id?: string) => void;
	select: (id: string) => void; result?: ExploreResult;
}) {
	const bodyRef = useRef<HTMLPreElement>(null);
	useEffect(() => {
		bodyRef.current?.querySelector('mark')?.scrollIntoView({ block: 'center' });
	}, [detail?.prompt.id]);
	if (!detail) {
		return <aside class="detail empty-detail">Select a prompt to see it in full.</aside>;
	}
	const { prompt, session: s, sessionPrompts, openTargets } = detail;
	const parent = s?.forkOf ? result?.sessions[s.forkOf] : undefined;
	return (
		<aside class="detail" aria-label="Prompt details">
			<div class="detail-head">
				<h2 title={s?.title}>{s?.title ?? 'Untitled session'}</h2>
				<div class="meta">
					<span>{new Date(prompt.timestamp).toLocaleString()}</span>
					{s?.client && <span>{CLIENT_LABELS[s.client] ?? s.client}</span>}
					{(s?.repository || s?.cwd) && <span title={s?.cwd}>{repoLabel(s)}{s?.branch ? ` · ${s.branch}` : ''}</span>}
					{prompt.model && <span>{prompt.model}</span>}
					{prompt.origin !== 'human' && <span class="tag">{ORIGIN_LABELS[prompt.origin]}</span>}
					<span>{prompt.text.length.toLocaleString()} chars</span>
				</div>
				<div class="actions">
					<button class="primary" onClick={() => act('copy', prompt.id)} title="Enter">Copy</button>
					<button onClick={() => act('insert', prompt.id)} title="Ctrl+Enter">Insert into chat</button>
					<button onClick={() => act('open', prompt.id)} title={openTargets[0]?.label ?? 'Open session'} disabled={!openTargets.length}>Open session</button>
					<button onClick={() => act('preview', prompt.id)} title="Open as a read-only document">Open as document</button>
				</div>
			</div>
			<pre class="detail-body" ref={bodyRef}><Highlighted text={prompt.text} terms={terms} /></pre>
			<div class="session-strip">
				<h3>In this session <span class="muted">({sessionPrompts.length})</span></h3>
				<ol>
					{sessionPrompts.map(p => (
						<Fragment key={p.id}>
							<li class={`${p.id === prompt.id ? 'current' : ''} ${p.origin !== 'human' ? 'not-human' : ''}`}>
								<button onClick={() => select(p.id)} title={p.text}>
									<span class="seq">{p.seq + 1}</span>
									<span class="txt">{p.text.trim().split(/\r?\n/, 1)[0]}</span>
									<span class="muted when">{relativeTime(p.timestamp)}</span>
								</button>
							</li>
							{s?.forkPointSeq === p.seq && (
								<li class="fork-point">⑂ forked from {parent?.title ? `“${parent.title}”` : 'another session'} — prompts below are new</li>
							)}
						</Fragment>
					))}
				</ol>
			</div>
		</aside>
	);
}

function GraphView({ vm, result, selectedId, select, reducedMotion, onActivate }: {
	vm: ViewModel; result: ExploreResult; selectedId?: string; select: (id: string) => void; reducedMotion: boolean; onActivate: (id: string) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const graphRef = useRef<ConstellationGraph>();
	const [legend, setLegend] = useState<{ group: string; color: string; count: number }[]>([]);
	const handlers = useRef({ select, onActivate });
	handlers.current = { select, onActivate };

	useEffect(() => {
		const g = new ConstellationGraph(canvasRef.current!, {
			reducedMotion,
			onSelect: id => handlers.current.select(id),
			onActivate: id => handlers.current.onActivate(id),
		});
		graphRef.current = g;
		return () => g.dispose();
	}, [reducedMotion]);

	useEffect(() => {
		const g = graphRef.current;
		if (!g) {
			return;
		}
		const { nodes, edges } = buildGraph(vm, result, 60);
		g.setData(result.freeText || result.query, nodes, edges);
		const counts = new Map<string, number>();
		nodes.forEach(n => counts.set(n.group, (counts.get(n.group) ?? 0) + 1));
		setLegend([...counts].map(([group, count]) => ({ group, count, color: g.colorFor(group) })));
	}, [vm, result, reducedMotion]);

	useEffect(() => graphRef.current?.setSelected(selectedId), [selectedId]);

	return (
		<div class="graph">
			<canvas ref={canvasRef} role="img" aria-label="Constellation of matching prompts: closer to the centre means more relevant" />
			<div class="legend">
				<div class="muted small">{result.freeText ? 'Closer to the centre = more relevant' : 'Closer to the centre = more recent'} · lines join prompts of one session · dashed = fork</div>
				{legend.map(l => <span key={l.group} class="legend-item"><i style={{ background: l.color }} />{l.group} <span class="muted">{l.count}</span></span>)}
			</div>
		</div>
	);
}

function Help({ onClose }: { onClose: () => void }) {
	const rows: [string, string][] = [
		['tree view design doc', 'Words and meaning (semantic + keyword)'],
		['"exact phrase"', 'Must contain the phrase'],
		['-draft', 'Must not contain the word'],
		['repo:PyRIT  branch:main  cwd:src', 'Session repository / branch / folder'],
		['after:2026-09  before:7d  on:yesterday', 'Dates: YYYY, YYYY-MM, YYYY-MM-DD, 7d, 2w, 3m, today'],
		['client:cli  client:agent-host  src:vscode', 'Where the prompt was sent'],
		['from:any  from:agent', 'Include agent / skill / system messages'],
		['mode:lex  mode:sem', 'Keyword-only or meaning-only'],
		['sort:recent', 'Newest first'],
	];
	const keys: [string, string][] = [['/', 'Focus search'], ['↑ ↓', 'Move'], ['Enter', 'Copy prompt'], ['Ctrl+Enter', 'Insert into chat'], ['O', 'Open session'], ['G', 'Toggle graph']];
	return (
		<div class="help" role="dialog" aria-label="Search help">
			<button class="icon close" onClick={onClose} aria-label="Close">×</button>
			<table>{rows.map(([q, d]) => <tr key={q}><td><code>{q}</code></td><td>{d}</td></tr>)}</table>
			<div class="keys">{keys.map(([k, d]) => <span key={k}><kbd>{k}</kbd> {d}</span>)}</div>
		</div>
	);
}

render(<App />, document.getElementById('root')!);
