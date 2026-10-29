import type { AgentProvider, ServerEvent } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

/**
 * Tells Clients to re-read the PTY Agent Terminals of a provider whose weekly usage guard just armed or lifted (issue
 * #2608), so the Terminal's guard notice appears and clears at once instead of on the next unrelated change. Chat
 * Terminals are left out: their snapshot carries the guard and is pushed by the Chat domain.
 */
export function pushUsageGuardToPtyTerminals(options: {
    guards: { subscribe(listener: (provider: AgentProvider) => void): () => void };
    database: Pick<CaxriDatabase, 'listTerminals'>;
    send: (event: ServerEvent) => void;
}): () => void {
    return options.guards.subscribe((provider) => {
        const terminalIds = options.database
            .listTerminals()
            .filter((terminal) => terminal.provider === provider && terminal.surface !== 'chat')
            .map((terminal) => terminal.id);
        if (terminalIds.length === 0) return;
        options.send({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds },
        });
    });
}
