import { useEffect, useMemo } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatPendingView } from '@caxri/protocol';

import {
    pruneAgentChatPending,
    selectAgentChatPendingAnswers,
    selectAgentChatPendingMessages,
    useAgentChatPendingStore,
} from '../agent-chat-pending';

/**
 * What this Chat shows ahead of its projection (`agentChatPendingView`): messages on their way, split by where they
 * land, the answers whose record has not arrived, and the requests already answered, whose cards leave at once.
 * Anything the snapshot now shows is filtered out during render, so a pending row and the real one never appear
 * together, and pruned right after.
 */
export function useAgentChatPending(terminalId: string, snapshot: AgentChatSnapshot | undefined) {
    const messages = useAgentChatPendingStore(selectAgentChatPendingMessages(terminalId));
    const answers = useAgentChatPendingStore(selectAgentChatPendingAnswers(terminalId));
    useEffect(() => {
        pruneAgentChatPending(terminalId, snapshot);
    }, [snapshot, terminalId]);
    return useMemo(
        () => agentChatPendingView(messages, answers, snapshot),
        [answers, messages, snapshot],
    );
}
