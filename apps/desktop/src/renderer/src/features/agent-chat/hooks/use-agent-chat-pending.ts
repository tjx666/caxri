import { useEffect, useMemo } from 'react';

import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';

import type { AgentChatPendingMessage } from '../agent-chat-pending';
import {
    isAgentChatPendingAnswerSettled,
    pruneAgentChatPending,
    selectAgentChatPendingAnswers,
    selectAgentChatPendingMessages,
    settledAgentChatPendingMessages,
    useAgentChatPendingStore,
} from '../agent-chat-pending';

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * What this Chat shows ahead of its projection: messages on their way, split by where they land, the answers whose
 * record has not arrived, and the requests already answered, whose cards leave at once. Anything the snapshot now shows
 * is filtered out during render, so a pending row and the real one never appear together, and pruned right after.
 */
export function useAgentChatPending(terminalId: string, snapshot: AgentChatSnapshot | undefined) {
    const messages = useAgentChatPendingStore(selectAgentChatPendingMessages(terminalId));
    const answers = useAgentChatPendingStore(selectAgentChatPendingAnswers(terminalId));
    useEffect(() => {
        pruneAgentChatPending(terminalId, snapshot);
    }, [snapshot, terminalId]);
    return useMemo(() => {
        const settled = settledAgentChatPendingMessages(messages, snapshot);
        const shown = messages.filter((message) => !settled.has(message.id));
        const unsettled = answers.filter(
            (answer) => !isAgentChatPendingAnswerSettled(answer, snapshot),
        );
        const timeline: AgentChatPendingMessage[] = [];
        const queue: AgentChatPendingMessage[] = [];
        for (const message of shown)
            (message.placement === 'queue' ? queue : timeline).push(message);
        return {
            timeline,
            queue,
            notices: unsettled.flatMap((answer): AgentChatItem[] =>
                answer.notice ? [answer.notice] : [],
            ),
            answeredRequestIds:
                unsettled.length === 0
                    ? EMPTY_IDS
                    : new Set(unsettled.map((answer) => answer.requestId)),
        };
    }, [answers, messages, snapshot]);
}
