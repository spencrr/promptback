import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** An Agents-window (agent host) session that wraps a Copilot SDK session. */
export interface AgentHostLink {
	readonly agentHostSessionId: string;
	readonly product: string;
	/** Peer chat id when the SDK session is a secondary chat inside the agent-host session. */
	readonly chatId?: string;
	readonly title?: string;
}

export interface AgentHostDbState {
	readonly mtimeMs: number;
	readonly size: number;
	readonly links: readonly { sdkSessionId: string; chatId?: string }[];
	readonly title?: string;
}

/** Lists `<productRoot>/agentSessionData/<agentHostSessionId>/session.db`. */
export function listAgentHostDbs(productRoot: string): { agentHostSessionId: string; dbPath: string }[] {
	const root = path.join(productRoot, 'agentSessionData');
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	return names.map(n => ({ agentHostSessionId: n, dbPath: path.join(root, n, 'session.db') }));
}

/**
 * Reads `session_metadata` of an agent-host session database (read-only).
 * `defaultChatProviderData.sdkSessionId` is the Copilot `session-state` id; `peerChats[].providerData` has the same for extra chats.
 */
export function readAgentHostDb(dbPath: string): Omit<AgentHostDbState, 'mtimeMs' | 'size'> {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db.prepare(
			`select key, value from session_metadata where key in ('defaultChatProviderData', 'peerChats', 'customTitle')`
		).all() as { key: string; value: string }[];
		const meta = new Map(rows.map(r => [r.key, r.value]));
		const links: { sdkSessionId: string; chatId?: string }[] = [];
		const main = sdkId(meta.get('defaultChatProviderData'));
		if (main) {
			links.push({ sdkSessionId: main });
		}
		try {
			const peers = JSON.parse(meta.get('peerChats') ?? '[]') as { uri?: string; providerData?: string }[];
			for (const peer of Array.isArray(peers) ? peers : []) {
				const id = sdkId(peer?.providerData);
				const chatId = peer?.uri ? chatIdFromUri(peer.uri) : undefined;
				if (id) {
					links.push({ sdkSessionId: id, chatId });
				}
			}
		} catch {
			// ignore malformed peers
		}
		return { links, title: meta.get('customTitle') || undefined };
	} finally {
		db.close();
	}
}

function sdkId(providerData: string | undefined): string | undefined {
	if (!providerData) {
		return undefined;
	}
	try {
		const v = (JSON.parse(providerData) as { sdkSessionId?: unknown }).sdkSessionId;
		return typeof v === 'string' && v ? v : undefined;
	} catch {
		return undefined;
	}
}

function chatIdFromUri(uri: string): string | undefined {
	const m = /^ahp-chat:\/\/([^/]+)/.exec(uri);
	return m?.[1] && m[1] !== 'default' ? decodeURIComponent(m[1]) : undefined;
}
