import { isAbsolute, join } from 'node:path';

import type { AgentEnvironment } from '../../contract';

export function grokHome(environment: AgentEnvironment): string {
    const configured = environment.variables.GROK_HOME;
    return configured
        ? isAbsolute(configured)
            ? configured
            : join(environment.homeDirectory, configured)
        : join(environment.homeDirectory, '.grok');
}

/**
 * Grok Build keys its per-conversation state by the canonical working directory, percent-encoded into one path segment.
 * Callers canonicalize the directory themselves; this stays pure path derivation so the launch contract and the
 * metadata probe cannot drift onto two different layouts.
 */
export function grokSessionDirectory(
    environment: AgentEnvironment,
    canonicalCwd: string,
    agentSessionId: string,
): string {
    return join(
        grokHome(environment),
        'sessions',
        encodeURIComponent(canonicalCwd),
        agentSessionId,
    );
}
