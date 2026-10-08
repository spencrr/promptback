/**
 * Child-process entry point. The VS Code extension forks this so model inference (hundreds of MB, multi-second
 * batches) never runs in the extension host. Communicates over Node IPC with {@link HostRequest}/{@link HostResponse}.
 */
import { PromptSearchEngine } from './engine.js';
import type { HostEvent, HostInitOptions, HostRequest, HostResponse } from './protocol.js';

let engine: PromptSearchEngine | undefined;
let lastSync = 0;
let timers: NodeJS.Timeout[] = [];
let retryTimer: NodeJS.Timeout | undefined;

function send(msg: HostResponse | HostEvent): void {
	process.send?.(msg);
}

function log(message: string): void {
	send({ type: 'event', name: 'log', data: message });
}

async function runSync(embed = true) {
	const e = engine!;
	lastSync = Date.now();
	const r = await e.sync({ embed, onProgress: p => send({ type: 'event', name: 'progress', data: p }) });
	lastSync = Date.now();
	send({ type: 'event', name: 'synced', data: r });
	if (!r.leader) {
		// Another process (e.g. a host that is shutting down, or another window) holds the lease; check again soon.
		clearTimeout(retryTimer);
		retryTimer = setTimeout(backgroundSync, 15_000);
	}
	return r;
}

function backgroundSync(): void {
	if (engine && !engine.isSyncing) {
		runSync().catch(e => log(`Sync failed: ${e instanceof Error ? e.stack : e}`));
	}
}

function init(opts: HostInitOptions) {
	if (engine) {
		return { indexDir: engine.indexDir };
	}
	engine = PromptSearchEngine.open({ ...opts, log });
	const interval = opts.syncIntervalMs ?? 120_000;
	if (interval > 0) {
		timers.push(setInterval(backgroundSync, interval));
	}
	const idle = opts.idleReleaseMs ?? 15 * 60_000;
	if (idle > 0) {
		timers.push(setInterval(() => void engine?.releaseProviderIfIdle(idle), 60_000));
	}
	setTimeout(backgroundSync, 0);
	return { indexDir: engine.indexDir };
}

async function handle(req: HostRequest): Promise<unknown> {
	if (req.method === 'init') {
		return init(req.params);
	}
	if (!engine) {
		throw new Error('Host not initialized');
	}
	switch (req.method) {
		case 'search':
			return engine.search(req.params);
		case 'explore':
			return engine.explore(req.params);
		case 'warm':
			void engine.warm();
			return undefined;
		case 'getPrompt':
			return engine.getPrompt(req.params);
		case 'getSessionPrompts':
			return engine.getSessionPrompts(req.params);
		case 'status':
			return { ...engine.status(), syncing: engine.isSyncing };
		case 'sync':
			return runSync(req.params.embed);
		case 'touch':
			if (Date.now() - lastSync > req.params.maxAgeMs) {
				backgroundSync();
			}
			return undefined;
		case 'recentSessions':
			return engine.recentSessions(req.params.limit);
		case 'setEmbeddingPaused':
			engine.setEmbeddingPaused(req.params);
			if (!req.params) {
				backgroundSync();
			}
			return undefined;
		case 'rebuildEmbeddings':
			await engine.rebuildEmbeddings();
			backgroundSync();
			return undefined;
	}
}

process.on('message', (msg: HostRequest) => {
	if (!msg || msg.type !== 'req') {
		return;
	}
	handle(msg).then(
		result => send({ type: 'res', id: msg.id, result }),
		(err: unknown) => send({ type: 'res', id: msg.id, error: err instanceof Error ? err.message : String(err) }),
	);
});

const shutdown = async () => {
	timers.forEach(clearInterval);
	timers = [];
	clearTimeout(retryTimer);
	try {
		await engine?.close();
	} finally {
		process.exit(0);
	}
};
process.on('disconnect', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
