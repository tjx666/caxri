import { createContext, useContext } from 'react';

/**
 * Whether this Chat's window can show delegated Sessions (`AgentChatHostCapabilities.canShowDelegatedSessions`): the
 * Delegated Sessions strip, the timeline's delegation records, and the delegated child's origin row. Defaults to
 * `false`, so a surface that never decides (a task tab's read-only timeline) shows none, and the Caxri Bot and
 * Benchmark windows, whose policies refuse the reads, never ask.
 */
export const CanShowDelegatedSessionsContext = createContext(false);

export function useCanShowDelegatedSessions(): boolean {
    return useContext(CanShowDelegatedSessionsContext);
}
