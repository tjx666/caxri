import { createContext, useContext } from 'react';

/**
 * Marks the part of a Chat timeline read back from the provider's history (`AgentChatSettledTimeline`). Those messages
 * are not in the live projection, so they never offer Edit from Here or Fork from Here; their right-click menu lists
 * both disabled with the reason instead of leaving them out silently. `canFork` says whether this window offers Fork at
 * all, so a host without it does not list a Fork that could never run.
 */
export const AgentChatReadBackHistoryContext = createContext<{ canFork: boolean } | undefined>(
    undefined,
);

export function useAgentChatReadBackHistory(): { canFork: boolean } | undefined {
    return useContext(AgentChatReadBackHistoryContext);
}
