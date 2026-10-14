import { promptSources } from './sources/registry.js';
import type { SessionInfo, SessionOpenTarget } from './types.js';

export { agentsWindowLink } from './sources/agentHost.js';
export type { SessionOpenTarget } from './types.js';

/** Ways to reopen/resume the session a prompt came from, best first; each source plugin decides for its sessions. */
export function sessionOpenTargets(s: SessionInfo): SessionOpenTarget[] {
	return promptSources.get(s.source)?.openTargets?.(s) ?? [];
}
