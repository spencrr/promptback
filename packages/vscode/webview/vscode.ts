/** The VS Code webview bridge, persisted state, and a "latest request wins" helper. */
import { useRef } from 'preact/hooks';
import type { FromWebview } from '../src/explorer/messages.js';
import type { ViewState } from './model.js';

export type ColumnKey = 'prompt' | 'topic' | 'session' | 'repo' | 'source' | 'when' | 'match' | 'length';

export interface Persisted {
	query: string;
	view: ViewState;
	mode: 'table' | 'graph';
	selectedId?: string;
	widths: Record<ColumnKey, number>;
}

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): Persisted | undefined; setState(s: Persisted): void };

export const vscode = acquireVsCodeApi();
export const post = (m: FromWebview) => vscode.postMessage(m);

/** Request ids per channel; responses for anything but the latest request are ignored. */
export function useLatest() {
	const next = useRef(1);
	const latest = useRef<Record<string, number>>({});
	return {
		begin(channel: string): number {
			const id = next.current++;
			latest.current[channel] = id;
			return id;
		},
		isLatest: (channel: string, id: number) => latest.current[channel] === id,
	};
}
