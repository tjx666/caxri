import type { AgentChatPatch, SessionRecord } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxriQueryKey } from '../../../queries/client';

const AGENT_CHAT_WAITING_QUERY_KEY = caxriQueryKey('agentChat.pendingRequests', {});

/**
 * Whether a patch can change which Chats wait on the user: it replaces a Chat's requests, changes whether a proposed
 * plan still awaits approval (turn or plan mode), or starts its projection over. Every other patch (streamed text,
 * items, usage) leaves the waiting list as it was, so it costs no read.
 */
export function isAgentChatWaitingPatch(patch: Pick<AgentChatPatch, 'operations'>): boolean {
    return patch.operations.some(
        (operation) =>
            operation.op === 'reset' ||
            (operation.op === 'state' &&
                ('requests' in operation.state ||
                    'activeTurnId' in operation.state ||
                    'planMode' in operation.state)),
    );
}

/**
 * Which Sessions' Primary Agents wait on the user, as one comparable string. It changes exactly when a PTY Terminal
 * Agent starts or stops waiting (or its Session appears, goes, or changes Primary Agent), which is when the list behind
 * the popup must be read again.
 */
export function waitingTerminalKey(
    sessions:
        | ReadonlyArray<Pick<SessionRecord, 'agentActivityState' | 'id' | 'primaryAgentTerminalId'>>
        | undefined,
): string {
    return (sessions ?? [])
        .filter((session) => session.agentActivityState === 'waiting')
        .map((session) => `${session.id}:${session.primaryAgentTerminalId ?? ''}`)
        .join('|');
}

/**
 * Re-reads the waiting list behind the popup. `agentChat.patch` reaches every window for every Chat, mounted or not, so
 * this push is what keeps a Chat no pane shows current without a poll.
 */
export function invalidateAgentChatWaiting(queryClient: QueryClient): void {
    void queryClient.invalidateQueries({ queryKey: AGENT_CHAT_WAITING_QUERY_KEY });
}
