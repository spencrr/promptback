import { Icon } from './common.js';

const QUERIES: [string, string][] = [
	['tree view design doc', 'Words and meaning (semantic + keyword)'],
	['"exact phrase"', 'Must contain the phrase'],
	['-draft', 'Must not contain the word'],
	['repo:PyRIT  branch:main  cwd:src', 'Session repository / branch / folder'],
	['after:2026-09  before:7d  on:yesterday', 'Dates: YYYY, YYYY-MM, YYYY-MM-DD, 7d, 2w, 3m, today'],
	['client:cli  client:agent-host  src:vscode', 'Where the prompt was sent'],
	['from:any  from:agent', 'Include agent / skill / system messages'],
	['session:7ab16897', 'One session (id prefix)'],
	['mode:lex  mode:sem', 'Keyword-only or meaning-only'],
	['sort:recent', 'Newest first'],
];
const KEYS: [string, string][] = [['/', 'Focus search'], ['↑ ↓', 'Move'], ['Enter', 'Copy prompt'], ['Ctrl+Enter', 'Insert into chat'], ['O', 'Open session'], ['G', 'Toggle graph']];

export function Help({ onClose }: { onClose: () => void }) {
	return (
		<div class="help" role="dialog" aria-label="Search help">
			<button class="icon close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
			<table>{QUERIES.map(([q, d]) => <tr key={q}><td><code>{q}</code></td><td>{d}</td></tr>)}</table>
			<div class="keys">{KEYS.map(([k, d]) => <span key={k}><kbd>{k}</kbd> {d}</span>)}</div>
		</div>
	);
}
