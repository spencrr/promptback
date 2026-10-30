/**
 * The Promptback results app: what hosts with the MCP Apps extension show for a `search_prompts` call. A compact list
 * of hits (the host's frame starts at ~300px), each expandable to the full prompt, with "Use this prompt" (puts the
 * text into the chat input; the user still sends it) and "Open session". Refining the query calls the app-only
 * `explore_prompts` tool through the host. Everything renders as text: prompts are the user's own words, never HTML.
 */
import './styles.css';
import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { highlightTerms, relativeTime, segments } from '../../vscode/webview/model.js';
import type { AppHit, AppSearchResult, SemanticStatus } from '../src/types.js';
import { Host, type ToolResult } from './host.js';

const SEARCH_ARGS = { limit: 10 };

interface State {
	readonly query: string;
	readonly result?: AppSearchResult;
	readonly loading: boolean;
	readonly error?: string;
}

function App() {
	const [state, setState] = useState<State>({ query: '', loading: true });
	const [expanded, setExpanded] = useState<string | undefined>();
	const [fullText, setFullText] = useState<Record<string, string>>({});
	const [notice, setNotice] = useState<string | undefined>();
	const [canInsert, setCanInsert] = useState(false);
	const [canOpen, setCanOpen] = useState(false);
	const hostRef = useRef<Host | undefined>(undefined);
	const rootRef = useRef<HTMLDivElement>(null);

	const applyResult = useCallback((result: ToolResult, query?: string) => {
		const data = result.structuredContent as AppSearchResult | undefined;
		if (result.isError || !data || !Array.isArray(data.hits)) {
			// `search_prompts` returns text for the model; the app re-runs the query through its structured twin.
			return false;
		}
		setState({ query: query ?? data.query, result: data, loading: false });
		return true;
	}, []);

	const search = useCallback(
		async (query: string) => {
			const host = hostRef.current;
			if (!host) {
				return;
			}
			setState(s => ({ ...s, query, loading: true, error: undefined }));
			try {
				const r = await host.callTool('explore_prompts', { query, ...SEARCH_ARGS });
				if (!applyResult(r, query)) {
					setState(s => ({ ...s, loading: false, error: 'The search returned no structured results.' }));
				}
			} catch (e) {
				setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
			}
		},
		[applyResult],
	);

	useEffect(() => {
		let lastQuery = '';
		const host = new Host({
			onToolInput: args => {
				lastQuery = typeof args.query === 'string' ? args.query : '';
				setState(s => ({ ...s, query: lastQuery }));
			},
			onToolResult: result => {
				// The opening call was `search_prompts` (text, for the model); fetch the structured form of the same query.
				if (!applyResult(result)) {
					void search(lastQuery);
				}
			},
			onHostContext: ctx => {
				if (ctx.theme) {
					document.documentElement.dataset.theme = ctx.theme;
				}
			},
		});
		hostRef.current = host;
		void host.connect({ name: 'Promptback', version: '0.6.0' }).then(() => {
			// VS Code handles `ui/message` but does not list it in its capabilities (it lists `openLinks`), so the
			// insert button is offered unless the host says otherwise, and a declined call is reported instead.
			setCanInsert(true);
			setCanOpen(host.capabilities.openLinks !== undefined);
		});
	}, [applyResult, search]);

	// Report the content height so the host sizes the frame to the list instead of a fixed box.
	useEffect(() => {
		const el = rootRef.current;
		const host = hostRef.current;
		if (!el || !host) {
			return;
		}
		const observer = new ResizeObserver(() => host.sizeChanged(Math.ceil(el.getBoundingClientRect().height) + 2));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const toggle = useCallback(
		async (hit: AppHit) => {
			if (expanded === hit.id) {
				setExpanded(undefined);
				return;
			}
			setExpanded(hit.id);
			if (fullText[hit.id] === undefined && hit.length > hit.preview.length) {
				const host = hostRef.current;
				if (!host) {
					return;
				}
				try {
					const r = await host.callTool('get_prompt', { id: hit.id });
					const text = r.content?.find(c => c.type === 'text')?.text ?? '';
					// get_prompt's text is a header, a blank line, then the prompt.
					const body = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : text;
					setFullText(m => ({ ...m, [hit.id]: body }));
				} catch {
					setFullText(m => ({ ...m, [hit.id]: hit.preview }));
				}
			}
		},
		[expanded, fullText],
	);

	const insert = useCallback(
		async (hit: AppHit) => {
			const host = hostRef.current;
			if (!host) {
				return;
			}
			const text = fullText[hit.id] ?? hit.preview;
			const ok = await host.insertIntoChat(text);
			setNotice(
				ok
					? 'Put into the chat input; edit it and press Enter to send.'
					: 'The chat input is not empty; clear it first.',
			);
			setTimeout(() => setNotice(undefined), 4000);
		},
		[fullText],
	);

	const terms = highlightTerms(state.result?.freeText ?? state.query);
	const r = state.result;

	return (
		<div class="app" ref={rootRef}>
			<form
				class="bar"
				onSubmit={e => {
					e.preventDefault();
					const input = (e.currentTarget.elements.namedItem('q') as HTMLInputElement).value;
					void search(input);
				}}
			>
				<input
					name="q"
					type="search"
					value={state.query}
					placeholder="Refine: words, repo:, after:, client:…"
					aria-label="Search prompts"
				/>
				<button type="submit" disabled={state.loading}>
					Search
				</button>
				{r ? (
					<span class="meta">
						{r.hits.length} {r.hits.length === 1 ? 'prompt' : 'prompts'} · {r.tookMs} ms
						{semanticLabel(r.semantic)}
					</span>
				) : null}
			</form>
			{state.error ? <p class="notice error">{state.error}</p> : null}
			{notice ? <p class="notice">{notice}</p> : null}
			{state.loading && !r ? <p class="muted">Searching your prompt history…</p> : null}
			{r && r.hits.length === 0 ? <p class="muted">No prompts matched. Try fewer or different words.</p> : null}
			<ol class="hits">
				{(r?.hits ?? []).map(hit => (
					<Hit
						key={hit.id}
						hit={hit}
						terms={terms}
						expanded={expanded === hit.id}
						fullText={fullText[hit.id]}
						canInsert={canInsert}
						canOpen={canOpen}
						onToggle={() => void toggle(hit)}
						onInsert={() => void insert(hit)}
						onOpen={uri => void hostRef.current?.openLink(uri)}
					/>
				))}
			</ol>
		</div>
	);
}

function Hit(p: {
	hit: AppHit;
	terms: readonly string[];
	expanded: boolean;
	fullText?: string;
	canInsert: boolean;
	canOpen: boolean;
	onToggle: () => void;
	onInsert: () => void;
	onOpen: (uri: string) => void;
}) {
	const { hit } = p;
	const where = [hit.session.repository ?? hit.session.cwd, hit.session.branch].filter(Boolean).join(' · ');
	const text = p.expanded ? (p.fullText ?? hit.preview) : firstLine(hit.preview);
	const openTargets = hit.session.open.filter(t => t.uri);
	return (
		<li class={p.expanded ? 'hit open' : 'hit'}>
			<button type="button" class="row" onClick={p.onToggle} aria-expanded={p.expanded}>
				<span class="text">
					<Highlighted text={text} terms={p.terms} />
					{p.expanded && p.fullText === undefined && hit.length > hit.preview.length ? (
						<span class="muted"> …</span>
					) : null}
				</span>
				<span class="sub">
					{hit.session.title ? <span class="title">{hit.session.title}</span> : null}
					{where ? <span>{where}</span> : null}
					{hit.session.client ? <span>{hit.session.client}</span> : null}
					<span>{relativeTime(hit.timestamp)}</span>
					{hit.duplicates > 0 ? <span>×{hit.duplicates + 1}</span> : null}
					{hit.moreInSession > 0 ? <span>+{hit.moreInSession} in session</span> : null}
				</span>
			</button>
			{p.expanded ? (
				<div class="actions">
					{p.canInsert ? (
						<button type="button" class="primary" onClick={p.onInsert}>
							Use this prompt
						</button>
					) : null}
					{p.canOpen
						? openTargets.map(t => (
								<button
									type="button"
									key={t.uri}
									onClick={() => p.onOpen(t.uri!)}
									title={t.bestEffort ? 'Best effort' : undefined}
								>
									{t.label}
								</button>
							))
						: null}
					<span class="muted id">{hit.id}</span>
				</div>
			) : null}
		</li>
	);
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
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

function firstLine(text: string): string {
	const line = text.trim().split(/\r?\n/u, 1)[0] ?? '';
	return line.length > 220 ? `${line.slice(0, 220)}…` : line;
}

function semanticLabel(s: SemanticStatus): string {
	switch (s.state) {
		case 'ready':
			return '';
		case 'pending':
			return ' · keywords only (semantic index warming up)';
		case 'off':
			return ' · keywords only';
		case 'failed':
			return ' · keywords only (semantic search unavailable)';
	}
}

render(<App />, document.querySelector('#root')!);
