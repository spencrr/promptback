/**
 * The MCP App behind `search_prompts`: an interactive results list that hosts supporting the MCP Apps extension
 * (VS Code chat and the Agents window, Claude Desktop, ...) render inline in place of the plain-text result.
 * Hosts without the extension ignore `_meta.ui` and show the text, so nothing here changes what the model sees.
 *
 * The app's data comes from `explore_prompts`, a tool marked app-only (`_meta.ui.visibility: ["app"]`): it returns
 * `structuredContent`, which in VS Code replaces the text a model would see, so it must not be the tool the model
 * calls. Hosts that ignore `visibility` may expose it to the model, which is why its description is honest.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PromptSearchEngine } from './engine.js';
import { sessionOpenTargets } from './links.js';
import type { AppHit, AppSearchResult, SearchHit } from './types.js';

export type { AppHit, AppSearchResult } from './types.js';

export const APP_RESOURCE_URI = 'ui://promptback/search.html';
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Injected by the build (esbuild `define`) from the bundled app; absent when the TypeScript source runs directly. */
declare const __PROMPTBACK_MCP_APP_HTML__: string | undefined;

/** The self-contained HTML of the app, or a placeholder page when the build did not embed one (tests, examples). */
export function appHtml(): string {
	if (typeof __PROMPTBACK_MCP_APP_HTML__ === 'string' && __PROMPTBACK_MCP_APP_HTML__.length > 0) {
		return __PROMPTBACK_MCP_APP_HTML__;
	}
	return '<!doctype html><html><body><p>Promptback app bundle not embedded in this build.</p></body></html>';
}

const PREVIEW_CHARS = 400;

export function toAppHit(h: SearchHit): AppHit {
	const s = h.session;
	return {
		id: h.prompt.id,
		sessionKey: s.key,
		timestamp: h.prompt.timestamp,
		origin: h.prompt.origin,
		model: h.prompt.model,
		preview: h.prompt.text.slice(0, PREVIEW_CHARS),
		length: h.prompt.text.length,
		matchRange: h.matchRange,
		lexicalRank: h.lexicalRank,
		semanticRank: h.semanticRank,
		duplicates: h.duplicates.length,
		moreInSession: h.moreInSession,
		session: {
			title: s.title,
			repository: s.repository,
			cwd: s.cwd,
			branch: s.branch,
			client: s.client,
			source: s.source,
			open: sessionOpenTargets(s),
		},
	};
}

/** Runs the search the app asks for and returns it as structured content (plus a one-line text for hosts that show it). */
export async function exploreForApp(engine: PromptSearchEngine, query: string, limit: number): Promise<CallToolResult> {
	const r = await engine.search({ text: query, limit });
	const result: AppSearchResult = {
		query: r.query,
		freeText: r.freeText,
		semantic: r.semantic,
		tookMs: r.tookMs,
		hits: r.hits.map(toAppHit),
	};
	return {
		content: [
			{
				type: 'text',
				text: `${r.hits.length} prompts for ${JSON.stringify(query)} (structured result for the Promptback app).`,
			},
		],
		structuredContent: result as unknown as Record<string, unknown>,
	};
}
