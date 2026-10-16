import './styles.css';
import type { ExploreResult } from '@promptback/core/types';
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PromptAction, ToWebview } from '../src/explorer/messages.js';
import { Icon } from './components/common.js';
import { Detail } from './components/Detail.js';
import { FacetRail } from './components/FacetRail.js';
import { GraphView } from './components/GraphView.js';
import { Help } from './components/Help.js';
import { IndexPanel, type IndexState } from './components/IndexPanel.js';
import { DEFAULT_WIDTHS, Table } from './components/Table.js';
import {
	type ColorBy,
	computeView,
	DEFAULT_VIEW,
	type GroupBy,
	highlightTerms,
	setClientCatalog,
	topicColors,
	type ViewModel,
	type ViewState,
} from './model.js';
import { type ColumnKey, post, useLatest, vscode } from './vscode.js';

const saved = vscode.getState();
type Mode = 'table' | 'graph';

function App() {
	const [query, setQuery] = useState(saved?.query ?? '');
	const [result, setResult] = useState<ExploreResult>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [view, setView] = useState<ViewState>({ ...DEFAULT_VIEW, ...saved?.view });
	const [mode, setMode] = useState<Mode>(saved?.mode ?? 'table');
	const [selectedId, setSelectedId] = useState<string | undefined>(saved?.selectedId);
	const [hoveredId, setHoveredId] = useState<string>();
	const [detail, setDetail] = useState<Extract<ToWebview, { type: 'detail' }>>();
	const [widths, setWidths] = useState<Record<ColumnKey, number>>({ ...DEFAULT_WIDTHS, ...saved?.widths });
	const [reducedMotion, setReducedMotion] = useState(false);
	const [showHelp, setShowHelp] = useState(false);
	const [showIndex, setShowIndex] = useState(false);
	const [indexState, setIndexState] = useState<IndexState>({});
	const [showFilters, setShowFilters] = useState(() => globalThis.innerWidth > 980);
	const latest = useLatest();
	const queryRef = useRef(query);
	queryRef.current = query;
	const pendingSelect = useRef<string | undefined>(undefined);
	const inputRef = useRef<HTMLInputElement>(null);

	const runQuery = useCallback(
		(text: string) => {
			setLoading(true);
			post({ type: 'query', requestId: latest.begin('query'), text });
		},
		[latest],
	);

	useEffect(() => {
		const open = (m: { query?: string; view?: Mode; selectId?: string; panel?: 'index' }) => {
			if (m.view) {
				setMode(m.view);
			}
			if (m.panel === 'index') {
				setShowIndex(true);
				post({ type: 'indexStatus' });
			}
			if (m.selectId) {
				pendingSelect.current = m.selectId;
				setSelectedId(m.selectId);
			}
			// An index-panel request keeps the current query.
			const q = m.panel && !m.query ? queryRef.current : (m.query ?? queryRef.current);
			setQuery(q);
			runQuery(q);
		};
		const onMessage = (e: MessageEvent<ToWebview>) => {
			const m = e.data;
			switch (m.type) {
				case 'init':
					setClientCatalog(m.catalog);
					setReducedMotion(m.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
					open(m);
					post({ type: 'indexStatus' });
					break;
				case 'open':
					open(m);
					inputRef.current?.focus();
					break;
				case 'result':
					if (latest.isLatest('query', m.requestId)) {
						setResult(m.result);
						setError(undefined);
						setLoading(false);
					}
					break;
				case 'error':
					if (latest.isLatest('query', m.requestId)) {
						setError(m.message);
						setLoading(false);
					}
					break;
				case 'detail':
					if (latest.isLatest('detail', m.requestId)) {
						setDetail(m);
					}
					break;
				case 'indexChanged':
					runQuery(queryRef.current);
					break;
				case 'indexStatus':
					setIndexState(s => ({
						...s,
						status: m.status ?? s.status,
						settings: m.settings,
						choices: m.choices,
						error: m.error,
					}));
					break;
				case 'progress':
					setIndexState(s => ({ ...s, progress: m.progress }));
					break;
			}
		};
		globalThis.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => globalThis.removeEventListener('message', onMessage);
	}, [latest, runQuery]);

	// Debounced search as you type.
	const firstRun = useRef(true);
	useEffect(() => {
		if (firstRun.current) {
			firstRun.current = false;
			return;
		}
		const t = setTimeout(() => runQuery(query), 180);
		return () => clearTimeout(t);
	}, [query, runQuery]);

	useEffect(
		() => vscode.setState({ query, view, mode, selectedId, widths }),
		[query, view, mode, selectedId, widths],
	);

	const vm = useMemo(() => (result ? computeView(result, view) : undefined), [result, view]);
	const topicColor = useMemo(() => (result ? topicColors(result) : new Map<number, string>()), [result]);

	// Keep a valid selection (an explicitly requested prompt wins once it is in the results).
	useEffect(() => {
		if (!vm) {
			return;
		}
		const wanted = pendingSelect.current;
		if (wanted && vm.rows.some(r => r.id === wanted)) {
			pendingSelect.current = undefined;
			setSelectedId(wanted);
		} else if (!selectedId || !vm.rows.some(r => r.id === selectedId)) {
			setSelectedId(vm.rows[0]?.id);
		}
	}, [vm, selectedId]);
	useEffect(() => {
		if (!selectedId) {
			setDetail(undefined);
			return;
		}
		const t = setTimeout(
			() => post({ type: 'detail', requestId: latest.begin('detail'), promptId: selectedId }),
			60,
		);
		return () => clearTimeout(t);
	}, [selectedId, latest]);

	const act = useCallback(
		(action: PromptAction, id = selectedId) => {
			if (id) {
				post({ type: 'action', action, promptId: id });
			}
		},
		[selectedId],
	);

	const move = useCallback(
		(delta: number) => {
			if (!vm?.rows.length) {
				return;
			}
			const i = vm.rows.findIndex(r => r.id === selectedId);
			setSelectedId(vm.rows[Math.max(0, Math.min(vm.rows.length - 1, (i < 0 ? 0 : i) + delta))]!.id);
		},
		[vm, selectedId],
	);

	const toggleGraph = useCallback(() => setMode(m => (m === 'graph' ? 'table' : 'graph')), []);
	useKeyboard({ inputRef, query, setQuery, move, act, toggleGraph });

	const terms = useMemo(() => highlightTerms(result?.freeText ?? ''), [result]);
	const activeFilters =
		view.facets.origin.length + view.facets.client.length + view.facets.repo.length + (view.dateRange ? 1 : 0);
	const embedding = indexState.status && indexState.status.pendingChunks > 0 && !indexState.status.embeddingPaused;

	return (
		<div class={`app ${showFilters ? '' : 'no-rail'}`}>
			<header class="topbar">
				<div class="search">
					<Icon name="search" />
					<input
						ref={inputRef}
						value={query}
						onInput={e => setQuery((e.target as HTMLInputElement).value)}
						placeholder='Search your prompts — try "tree view design doc" repo:PyRIT after:2026-09'
						aria-label="Search prompts"
						autofocus={true}
						spellcheck={false}
					/>
					{loading ? <span class="spinner" role="status" aria-label="Searching" /> : null}
					{query !== '' && (
						<button type="button" class="icon" title="Clear (Esc)" onClick={() => setQuery('')}>
							<Icon name="close" />
						</button>
					)}
					<button
						type="button"
						class="icon"
						title="Query syntax and shortcuts"
						aria-expanded={showHelp}
						onClick={() => setShowHelp(s => !s)}
					>
						<Icon name="question" />
					</button>
				</div>
				<div class="summary" aria-live="polite">
					{vm && <Summary vm={vm} result={result!} />}
				</div>
				<div class="toolbar">
					<button
						type="button"
						class={`toggle ${showFilters ? 'on' : ''}`}
						onClick={() => setShowFilters(s => !s)}
						title="Show or hide filters"
					>
						<Icon name="filter" />
						Filters{activeFilters ? <span class="count-badge">{activeFilters}</span> : null}
					</button>
					<div class="segmented" role="tablist" aria-label="View">
						<button
							type="button"
							role="tab"
							aria-selected={mode === 'table'}
							class={mode === 'table' ? 'on' : ''}
							onClick={() => setMode('table')}
						>
							<Icon name="table" />
							Table
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={mode === 'graph'}
							class={mode === 'graph' ? 'on' : ''}
							onClick={() => setMode('graph')}
							title="Constellation view (G)"
						>
							<Icon name="type-hierarchy-sub" />
							Graph
						</button>
					</div>
					{mode === 'table' ? (
						<Select
							label="Group"
							icon="list-tree"
							value={view.groupBy}
							onChange={v => setView(s => ({ ...s, groupBy: v as GroupBy }))}
							options={[
								['none', 'No grouping'],
								['day', 'Day'],
								['session', 'Session'],
								['repo', 'Repository'],
								['topic', 'Topic'],
							]}
						/>
					) : (
						<Select
							label="Colour"
							icon="symbol-color"
							value={view.colorBy}
							onChange={v => setView(s => ({ ...s, colorBy: v as ColorBy }))}
							options={[
								['topic', 'Topic'],
								['repo', 'Repository'],
								['source', 'Source'],
								['session', 'Session'],
							]}
						/>
					)}
					<label class="check" title="Show each identical prompt once (forks, re-pasted prompts)">
						<input
							type="checkbox"
							checked={view.hideDuplicates}
							onChange={() => setView(v => ({ ...v, hideDuplicates: !v.hideDuplicates }))}
						/>
						Hide duplicates
					</label>
					<button
						type="button"
						class={`toggle ${showIndex ? 'on' : ''}`}
						onClick={() => {
							setShowIndex(s => !s);
							post({ type: 'indexStatus' });
						}}
						title="Index status, embedding model and settings"
					>
						<Icon name={embedding ? 'sync~spin' : 'database'} />
						Index
					</button>
				</div>
				{showHelp ? <Help onClose={() => setShowHelp(false)} /> : null}
			</header>

			{showFilters && vm ? <FacetRail vm={vm} view={view} setView={setView} /> : null}

			<main class="center">
				{error ? (
					<div class="banner error">
						<Icon name="error" />
						Search failed: {error}
					</div>
				) : null}
				{result?.semanticUnavailable ? (
					<div class="banner">
						<Icon name="info" />
						Semantic search is warming up — showing keyword matches for now.
					</div>
				) : null}
				{vm && mode === 'table' && (
					<Table
						vm={vm}
						result={result!}
						terms={terms}
						view={view}
						setView={setView}
						selectedId={selectedId}
						select={setSelectedId}
						hoveredId={hoveredId}
						hover={setHoveredId}
						topicColor={topicColor}
						widths={widths}
						setWidths={setWidths}
						onActivate={id => act('copy', id)}
					/>
				)}
				{vm && mode === 'graph' && (
					<GraphView
						vm={vm}
						result={result!}
						colorBy={view.colorBy}
						selectedId={selectedId}
						hoveredId={hoveredId}
						select={setSelectedId}
						hover={setHoveredId}
						reducedMotion={reducedMotion}
						onActivate={id => act('copy', id)}
					/>
				)}
				{!vm && (
					<div class="empty">
						<span class="spinner" />
						Loading your prompt history…
					</div>
				)}
				{showIndex ? <IndexPanel state={indexState} onClose={() => setShowIndex(false)} /> : null}
			</main>

			<Detail
				detail={detail}
				terms={terms}
				act={act}
				select={setSelectedId}
				result={result}
				topicColor={topicColor}
			/>
		</div>
	);
}

function Summary({ vm, result }: { vm: ViewModel; result: ExploreResult }) {
	const shown = vm.rows.length;
	const what = result.freeText
		? `${shown.toLocaleString()} matching prompt${shown === 1 ? '' : 's'}`
		: `${shown.toLocaleString()} prompts`;
	const hidden = vm.totalMatches - shown;
	return (
		<span>
			<b>{what}</b>
			{hidden > 0 ? <span class="muted"> · {hidden.toLocaleString()} filtered or duplicate</span> : null}
			{result.topics.length > 0 ? <span class="muted"> · {result.topics.length} topics</span> : null}
			<span class="muted"> · {result.tookMs} ms</span>
		</span>
	);
}

function Select({
	label,
	icon,
	value,
	onChange,
	options,
}: {
	label: string;
	icon: string;
	value: string;
	onChange: (v: string) => void;
	options: [string, string][];
}) {
	return (
		<label class="select" title={label}>
			<Icon name={icon} />
			<span class="sr-only">{label}</span>
			<select value={value} onChange={e => onChange((e.target as HTMLSelectElement).value)}>
				{options.map(([v, l]) => (
					<option key={v} value={v}>
						{l}
					</option>
				))}
			</select>
		</label>
	);
}

/** Global shortcuts. Keys on buttons, links and form fields (other than the search box) are left alone. */
function useKeyboard(o: {
	inputRef: { current: HTMLInputElement | null };
	query: string;
	setQuery: (q: string) => void;
	move: (delta: number) => void;
	act: (a: PromptAction) => void;
	toggleGraph: () => void;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const inSearch = target === o.inputRef.current;
			if (!inSearch && target.closest('button, a, input, select, textarea, [role="dialog"]')) {
				return;
			}
			if (e.key === '/' && !inSearch) {
				e.preventDefault();
				o.inputRef.current?.focus();
				o.inputRef.current?.select();
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				o.move(e.key === 'ArrowDown' ? 1 : -1);
			} else if (e.key === 'PageDown' || e.key === 'PageUp') {
				e.preventDefault();
				o.move(e.key === 'PageDown' ? 15 : -15);
			} else if (e.key === 'Enter') {
				e.preventDefault();
				o.act(e.ctrlKey || e.metaKey ? 'insert' : 'copy');
			} else if (!inSearch && e.key.toLowerCase() === 'o') {
				o.act('open');
			} else if (!inSearch && e.key.toLowerCase() === 'g') {
				o.toggleGraph();
			} else if (e.key === 'Escape' && inSearch && o.query) {
				o.setQuery('');
			}
		};
		globalThis.addEventListener('keydown', onKey);
		return () => globalThis.removeEventListener('keydown', onKey);
	}, [o.move, o.act, o.query, o.setQuery, o.toggleGraph, o.inputRef]);
}

render(<App />, document.getElementById('root')!);
