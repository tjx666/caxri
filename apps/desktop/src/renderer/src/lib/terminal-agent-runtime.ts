import type { ProcessState } from '@caxri/protocol';

/**
 * A Terminal keeps its Agent association after the Agent child exits. Only the live child state enables Agent-specific
 * input; the surrounding shell otherwise keeps its normal keyboard and clipboard behavior.
 */
export function isAgentProcessRunning(lastAgentProcessState: ProcessState | undefined): boolean {
    return lastAgentProcessState === 'running';
}

/**
 * Whether Server Core answers `agentActions.list` for this Terminal, which it does only while the Terminal process
 * itself runs (`apps/server/src/domains/agents/actions.ts`). The stored Agent state alone is not enough: after a
 * restart a Chat resumes lazily, so its Terminal reads `interrupted` while the Agent state it last recorded still reads
 * `running`, and a read in that window fails with `UNAVAILABLE`.
 */
export function canDiscoverAgentActions(
    terminal: { lastAgentProcessState?: ProcessState; lastProcessState: ProcessState } | undefined,
): boolean {
    return (
        terminal?.lastProcessState === 'running' &&
        isAgentProcessRunning(terminal.lastAgentProcessState)
    );
}
