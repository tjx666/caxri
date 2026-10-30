import type {
    AgentChatPendingAnswer,
    AgentChatPendingMessageBase,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    AGENT_CHAT_PENDING_ACCEPTED_TTL_MS,
    agentChatPendingKnownIds,
    agentChatPendingPlacement,
    unsettledAgentChatPendingAnswers,
    unsettledAgentChatPendingMessages,
} from '@caxri/protocol';

import { createStore } from '../../../lib/store';

/**
 * A message the user sent that the projection does not show yet, with the thumbnails the Desktop timeline previews.
 * Where it lands and when the projection takes over follow the shared rules in `@caxri/protocol`
 * (`agentChatPendingPlacement`, `isAgentChatPendingMessageSettled`).
 */
export interface AgentChatPendingMessage extends AgentChatPendingMessageBase {
    images: ReadonlyArray<{ thumbnail: string }>;
    /**
     * What the message waits for, decided when it was sent (see {@link agentChatPendingWait}).
     */
    wait?: AgentChatPendingWait;
}

/**
 * What a message on its way is waiting for, for the hint behind its sending clock: the running turn's current step when
 * it steers that turn (Codex records steered input only once the step ends), the Agent starting or resuming (a stopped
 * Chat resumes on its next message), or plain delivery.
 */
export type AgentChatPendingWait = 'step' | 'start' | 'delivery';

export function agentChatPendingWait(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'status'> | undefined,
    delivery: 'queue' | 'steer' | undefined,
): AgentChatPendingWait {
    if (delivery === 'steer' && snapshot?.activeTurnId) return 'step';
    return snapshot?.status === 'ready' || snapshot?.status === 'failed' ? 'delivery' : 'start';
}

interface AgentChatPendingState {
    messages: Readonly<Record<string, readonly AgentChatPendingMessage[]>>;
    answers: Readonly<Record<string, readonly AgentChatPendingAnswer[]>>;
}

/**
 * Pending sends and answers per Chat Terminal. Module state rather than component state, because the composer that
 * sends and the timeline and dock that show the result are siblings, and a pane remount must not drop a send in
 * flight.
 */
export const useAgentChatPendingStore = createStore<AgentChatPendingState>(
    'agent-chat-pending',
    () => ({ messages: {}, answers: {} }),
);

const EMPTY_MESSAGES: readonly AgentChatPendingMessage[] = [];
const EMPTY_ANSWERS: readonly AgentChatPendingAnswer[] = [];

export function selectAgentChatPendingMessages(
    terminalId: string,
): (state: AgentChatPendingState) => readonly AgentChatPendingMessage[] {
    return (state) => state.messages[terminalId] ?? EMPTY_MESSAGES;
}

export function selectAgentChatPendingAnswers(
    terminalId: string,
): (state: AgentChatPendingState) => readonly AgentChatPendingAnswer[] {
    return (state) => state.answers[terminalId] ?? EMPTY_ANSWERS;
}

function updateMessages(
    terminalId: string,
    update: (current: readonly AgentChatPendingMessage[]) => readonly AgentChatPendingMessage[],
): void {
    const { messages } = useAgentChatPendingStore.getState();
    const current = messages[terminalId] ?? EMPTY_MESSAGES;
    const next = update(current);
    if (next === current) return;
    useAgentChatPendingStore.setState({ messages: { ...messages, [terminalId]: next } });
}

function updateAnswers(
    terminalId: string,
    update: (current: readonly AgentChatPendingAnswer[]) => readonly AgentChatPendingAnswer[],
): void {
    const { answers } = useAgentChatPendingStore.getState();
    const current = answers[terminalId] ?? EMPTY_ANSWERS;
    const next = update(current);
    if (next === current) return;
    useAgentChatPendingStore.setState({ answers: { ...answers, [terminalId]: next } });
}

function addAgentChatPendingMessage(terminalId: string, message: AgentChatPendingMessage): void {
    updateMessages(terminalId, (current) => [...current, message]);
}

export function dropAgentChatPendingMessage(terminalId: string, id: string): void {
    updateMessages(terminalId, (current) =>
        current.some((message) => message.id === id)
            ? current.filter((message) => message.id !== id)
            : current,
    );
}

export function addAgentChatPendingAnswer(
    terminalId: string,
    answer: AgentChatPendingAnswer,
): void {
    updateAnswers(terminalId, (current) => [
        ...current.filter((pending) => pending.requestId !== answer.requestId),
        answer,
    ]);
}

export function dropAgentChatPendingAnswer(terminalId: string, requestId: string): void {
    updateAnswers(terminalId, (current) =>
        current.some((pending) => pending.requestId === requestId)
            ? current.filter((pending) => pending.requestId !== requestId)
            : current,
    );
}

/**
 * Drops what the projection now shows, so the pending rows hand over to the real ones in the same commit.
 */
export function pruneAgentChatPending(
    terminalId: string,
    snapshot: AgentChatSnapshot | undefined,
): void {
    updateMessages(terminalId, (current) => unsettledAgentChatPendingMessages(current, snapshot));
    updateAnswers(terminalId, (current) => unsettledAgentChatPendingAnswers(current, snapshot));
}

/**
 * Shows a message the composer is sending, where it is going to land, and returns its id.
 */
export function showAgentChatPendingMessage(
    terminalId: string,
    snapshot: AgentChatSnapshot | undefined,
    message: {
        text: string;
        images: ReadonlyArray<{ thumbnail: string }>;
        /**
         * The message's image count when it carries images the Client holds no thumbnails for (a queued message).
         */
        imageCount?: number;
        delivery: 'queue' | 'steer' | undefined;
        /**
         * The user message an edit sends this one in place of; see `AgentChatPendingMessageBase.replaces`.
         */
        replaces?: string;
    },
): string {
    const ahead = selectAgentChatPendingMessages(terminalId)(useAgentChatPendingStore.getState());
    const id = crypto.randomUUID();
    addAgentChatPendingMessage(terminalId, {
        id,
        text: message.text,
        images: message.images,
        imageCount: message.imageCount ?? message.images.length,
        placement: agentChatPendingPlacement(snapshot, message.delivery, ahead.length > 0),
        knownIds: agentChatPendingKnownIds(snapshot),
        // An edit restarts the Agent on the rewound conversation before it sends.
        wait:
            message.replaces === undefined
                ? agentChatPendingWait(snapshot, message.delivery)
                : 'start',
        ...(message.replaces !== undefined && { replaces: message.replaces }),
    });
    return id;
}

/**
 * Bounds an accepted message's pending row (see {@link AGENT_CHAT_PENDING_ACCEPTED_TTL_MS}); the projection showing it
 * usually drops the row long before. The bound restarts while the context compacts: a provider records input that
 * arrived meanwhile only once the compaction ends, which can take minutes.
 */
export function expireAgentChatPendingMessage(
    terminalId: string,
    id: string,
    snapshotOf: (terminalId: string) => AgentChatSnapshot | undefined,
): void {
    setTimeout(() => {
        if (snapshotOf(terminalId)?.operation === 'compacting')
            expireAgentChatPendingMessage(terminalId, id, snapshotOf);
        else dropAgentChatPendingMessage(terminalId, id);
    }, AGENT_CHAT_PENDING_ACCEPTED_TTL_MS);
}
