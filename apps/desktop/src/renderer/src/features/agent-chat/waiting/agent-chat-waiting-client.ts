import type { AgentChatPatch } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxriQueryKey } from '../../../queries/client';

const AGENT_CHAT_WAITING_QUERY_KEY = caxriQueryKey('agentChat.pendingRequests', {});

/**
 * Whether a patch can change which Chats wait on the user: it replaces a Chat's requests, or starts its projection
 * over. Every other patch (streamed text, items, usage) leaves the waiting list as it was, so it costs no read.
 */
export function isAgentChatWaitingPatch(patch: Pick<AgentChatPatch, 'operations'>): boolean {
    return patch.operations.some(
        (operation) =>
            operation.op === 'reset' || (operation.op === 'state' && 'requests' in operation.state),
    );
}

/**
 * Re-reads the waiting list behind the popup. `agentChat.patch` reaches every window for every Chat, mounted or not, so
 * this push is what keeps a Chat no pane shows current without a poll.
 */
export function invalidateAgentChatWaiting(queryClient: QueryClient): void {
    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
    void queryClient.invalidateQueries({ queryKey: AGENT_CHAT_WAITING_QUERY_KEY });
}
