import { createStore } from '../../../lib/store';

interface AgentChatCacheNoticeDismissals {
    /**
     * Per Chat Terminal, the `lastResponseAt` of the reply after which the user dismissed the cache notice. Memory
     * only: the notice is a cost hint, so forgetting a dismissal on restart costs one more look at it, never a wrong
     * answer.
     */
    dismissedResponseAt: Readonly<Partial<Record<string, number>>>;
}

export const useAgentChatCacheNoticeDismissals = createStore<AgentChatCacheNoticeDismissals>(
    'agentChatCacheNoticeDismissals',
    () => ({ dismissedResponseAt: {} }),
);

/**
 * Hides the cache notice of `terminalId` until a reply newer than `lastResponseAt` arrives
 * (`agentChatUndismissedContextAlerts`).
 */
export function dismissAgentChatCacheNotice(terminalId: string, lastResponseAt: number): void {
    useAgentChatCacheNoticeDismissals.setState(({ dismissedResponseAt }) => ({
        dismissedResponseAt: { ...dismissedResponseAt, [terminalId]: lastResponseAt },
    }));
}
