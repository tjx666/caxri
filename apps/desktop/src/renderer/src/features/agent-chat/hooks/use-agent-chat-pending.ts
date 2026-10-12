import { useEffect, useMemo } from 'react';

import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';

import type { AgentChatPendingMessage } from '../agent-chat-pending';
import {
    isAgentChatPendingAnswerSettled,
    isAgentChatPendingMessageSettled,
    pruneAgentChatPending,
    selectAgentChatPendingAnswers,
    selectAgentChatPendingMessages,
    useAgentChatPendingStore,
} from '../agent-chat-pending';

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * What this Chat shows ahead of its projection: messages on their way, split by where they land, the answers whose
 * record has not arrived, the requests already answered, whose cards leave at once, and the questions still asked.
 * Anything the snapshot now shows is filtered out during render, so a pending row and the real one never appear
 * together, and pruned right after.
 */
export function useAgentChatPending(terminalId: string, snapshot: AgentChatSnapshot | undefined) {
    const messages = useAgentChatPendingStore(selectAgentChatPendingMessages(terminalId));
    const answers = useAgentChatPendingStore(selectAgentChatPendingAnswers(terminalId));
    useEffect(() => {
        pruneAgentChatPending(terminalId, snapshot);
    }, [snapshot, terminalId]);
    return useMemo(() => {
        const shown = messages.filter(
            (message) => !isAgentChatPendingMessageSettled(message, snapshot),
        );
        const unsettled = answers.filter(
            (answer) => !isAgentChatPendingAnswerSettled(answer, snapshot),
        );
        const timeline: AgentChatPendingMessage[] = [];
        const queue: AgentChatPendingMessage[] = [];
        for (const message of shown)
            (message.placement === 'queue' ? queue : timeline).push(message);
        const answeredRequestIds =
            unsettled.length === 0
                ? EMPTY_IDS
                : new Set(unsettled.map((answer) => answer.requestId));
        return {
            /**
             * Question requests still waiting on their card, which the timeline marks with an Asking row.
             */
            asking: (snapshot?.requests ?? []).filter(
                (request) => request.kind === 'question' && !answeredRequestIds.has(request.id),
            ),
            timeline,
            queue,
            notices: unsettled.flatMap((answer): AgentChatItem[] =>
                answer.notice ? [answer.notice] : [],
            ),
            answeredRequestIds,
        };
    }, [answers, messages, snapshot]);
}
