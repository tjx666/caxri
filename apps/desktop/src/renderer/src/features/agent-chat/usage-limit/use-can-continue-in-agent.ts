import { createContext, useContext } from 'react';

/**
 * Whether this Chat's window can continue its work in another Agent (`AgentChatHostCapabilities.canContinueInAgent`).
 * Defaults to `false`, so a surface that never decides (a task tab's read-only timeline) offers no continuation.
 */
export const CanContinueInAgentContext = createContext(false);

export function useCanContinueInAgent(): boolean {
    return useContext(CanContinueInAgentContext);
}
