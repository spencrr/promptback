import type { IndexStatus, SyncProgress } from '@promptback/core/types';
import type { IndexAction, IndexChoices, IndexSettings } from '../../src/explorer/messages.js';
import { relativeTime } from '../model.js';
import { post } from '../vscode.js';
import { Icon } from './common.js';

const ORIGINS: { id: string; label: string }[] = [
	{ id: 'human', label: 'Your prompts' },
	{ id: 'agent', label: 'Agent messages' },
	{ id: 'skill', label: 'Skill messages' },
	{ id: 'system', label: 'System messages' },
];

export interface IndexState {
	readonly status?: IndexStatus & { syncing: boolean };
	readonly settings?: IndexSettings;
	/** Registered providers and models, from the host. */
	readonly choices?: IndexChoices;
	readonly error?: string;
	readonly progress?: SyncProgress;
}

/** Index health and embedding controls. Changes are written to settings (the single source of truth). */
export function IndexPanel({ state, onClose }: { state: IndexState; onClose: () => void }) {
	const { status: s, settings: cfg, progress } = state;
	const choices = state.choices ?? { providers: [], models: [] };
	const set = (key: keyof IndexSettings, value: unknown) => post({ type: 'setSetting', key, value });
	const act = (action: IndexAction) => post({ type: 'indexAction', action });
	const pct = s && s.chunks ? Math.round((s.embeddedChunks / s.chunks) * 100) : 0;
	const working = progress && progress.phase !== 'done' ? progress : undefined;
	return (
		<div class="drawer" role="dialog" aria-label="Index and model">
			<div class="drawer-head">
				<h2><Icon name="database" />Index &amp; model</h2>
				<button class="icon" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
			</div>

			{state.error && <div class="banner error">The index process is not responding: {state.error}</div>}

			<section>
				<h3>Status</h3>
				{s ? (
					<>
						<div class="stat-grid">
							<span class="muted">Prompts</span><span>{s.prompts.toLocaleString()} in {s.sessions.toLocaleString()} sessions</span>
							<span class="muted">Semantic</span>
							<span>
								<span class="progress"><span style={{ width: `${pct}%` }} /></span>
								{s.embeddedChunks.toLocaleString()} / {s.chunks.toLocaleString()} chunks ({pct}%)
								{s.embeddingPaused && <span class="tag">paused</span>}
							</span>
							<span class="muted">Model</span><span>{s.model ?? 'none'}{s.model && !s.modelLoaded ? <span class="muted"> (loads on first search)</span> : null}</span>
							<span class="muted">Last scan</span><span>{s.lastSyncAt ? relativeTime(s.lastSyncAt) : 'never'}{s.syncing ? ' · scanning now' : ''}</span>
							<span class="muted">Index</span><span title={s.indexPath}>{(s.indexBytes / 1048576).toFixed(1)} MB</span>
						</div>
						{working && <div class="working"><span class="spinner" />{working.message}</div>}
						{!!s.errors.length && (
							<details class="problems">
								<summary><Icon name="warning" />{s.errors.length} problem{s.errors.length === 1 ? '' : 's'}</summary>
								<ul>{s.errors.slice(0, 10).map(e => <li key={e}>{e}</li>)}</ul>
							</details>
						)}
					</>
				) : <div class="muted">Loading…</div>}
				<div class="actions">
					<button class="primary" onClick={() => act('reindex')} disabled={s?.syncing}><Icon name="sync" />Scan now</button>
					{s?.embeddingPaused
						? <button onClick={() => act('resume')}><Icon name="debug-start" />Resume embedding</button>
						: <button onClick={() => act('pause')} disabled={!s?.pendingChunks}><Icon name="debug-pause" />Pause embedding</button>}
					<button onClick={() => act('rebuild')}><Icon name="refresh" />Rebuild embeddings</button>
				</div>
			</section>

			{cfg && (
				<section>
					<h3>Semantic search</h3>
					<label class="field">
						<span>Embeddings</span>
						<select value={cfg.provider} onChange={e => set('provider', (e.target as HTMLSelectElement).value)}>
							{choices.providers.map(p => (
								<option key={p.id} value={p.id}>{p.label}{p.local ? '' : ' (remote)'}</option>
							))}
						</select>
					</label>
					{choices.providers.find(p => p.id === cfg.provider)?.description && (
						<div class="muted small">{choices.providers.find(p => p.id === cfg.provider)?.description}</div>
					)}
					{cfg.provider === 'local' && (
						<>
							<div class="field">
								<span>Model</span>
								<div class="radio-list">
									{choices.models.map(m => (
										<label key={m.id} class="radio">
											<input type="radio" name="model" checked={cfg.model === m.id} onChange={() => set('model', m.id)} />
											<span><b>{m.label}</b><span class="muted small">{m.detail}</span></span>
										</label>
									))}
								</div>
							</div>
							<label class="field">
								<span>CPU threads</span>
								<input type="number" min={1} max={32} value={cfg.threads} onChange={e => set('threads', Number((e.target as HTMLInputElement).value))} />
							</label>
							<label class="check"><input type="checkbox" checked={cfg.allowDownload} onChange={() => set('allowDownload', !cfg.allowDownload)} />Allow downloading models (pinned, hash-verified; no prompt text is sent)</label>
						</>
					)}
					{cfg.provider === 'openai-compatible' && (
						<>
							<div class="banner warn"><Icon name="warning" />The endpoint receives the text of your prompts.</div>
							<label class="field">
								<span>Base URL</span>
								<input type="text" value={cfg.openaiBaseUrl} placeholder="https://<resource>.openai.azure.com/openai/v1" onChange={e => set('openaiBaseUrl', (e.target as HTMLInputElement).value)} />
							</label>
							<label class="field">
								<span>Model / deployment</span>
								<input type="text" value={cfg.openaiModel} onChange={e => set('openaiModel', (e.target as HTMLInputElement).value)} />
							</label>
							<div class="muted small">API key: set <code>promptback.embedding.openai.apiKeyEnv</code> to the name of an environment variable (keys are never stored in settings).</div>
						</>
					)}
					<div class="field">
						<span>Embed</span>
						<div class="checks">
							{ORIGINS.map(o => (
								<label key={o.id} class="check">
									<input type="checkbox" checked={cfg.embedOrigins.includes(o.id)}
										onChange={() => set('embedOrigins', cfg.embedOrigins.includes(o.id) ? cfg.embedOrigins.filter(x => x !== o.id) : [...cfg.embedOrigins, o.id])} />
									{o.label}
								</label>
							))}
						</div>
						<span class="muted small">Everything is keyword-searchable; only checked kinds get semantic embeddings.</span>
					</div>
					<label class="field">
						<span>Background scan</span>
						<select value={String(cfg.backgroundIntervalMinutes)} onChange={e => set('backgroundIntervalMinutes', Number((e.target as HTMLSelectElement).value))}>
							<option value="1">Every minute</option>
							<option value="2">Every 2 minutes</option>
							<option value="10">Every 10 minutes</option>
							<option value="0">Only when searching</option>
						</select>
					</label>
				</section>
			)}

			<section class="links">
				<button class="link" onClick={() => act('openSettings')}><Icon name="settings-gear" />All settings</button>
				<button class="link" onClick={() => act('showLog')}><Icon name="output" />Show log</button>
				<button class="link" onClick={() => act('revealIndex')}><Icon name="folder-opened" />Reveal index file</button>
			</section>
		</div>
	);
}
