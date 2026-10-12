import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';

import { createStore } from '../../lib/store';

/**
 * A message the user sent that the projection does not show yet. Sending takes a round trip through Server Core and,
 * before the user message appears, the provider (Codex answers `turn/start` first, and a busy Chat serializes its
 * inputs), so the composer used to keep the draft and the timeline stayed empty until then, which read as the send
 * being ignored. The message now shows at once, where it is going to land, until the projection holds it.
 */
export interface AgentChatPendingMessage {
    id: string;
    text: string;
    images: ReadonlyArray<{ thumbnail: string }>;
    /**
     * Where the message lands: the end of the timeline when it starts or steers a turn, the queue list when it waits.
     */
    placement: 'queue' | 'timeline';
    /**
     * User message and queue entry ids the projection held when the message was sent; only an entry outside them can be
     * this message.
     */
    knownIds: ReadonlySet<string>;
}

/**
 * A question answered whose request the projection still holds. Its card leaves at once and the answer shows in the
 * timeline, as Server Core will record it.
 */
export interface AgentChatPendingAnswer {
    requestId: string;
    notice: AgentChatItem | undefined;
}

/**
 * How long an accepted message keeps showing when the projection never shows anything it can be matched to (a provider
 * that rewrote its text beyond recognition), so a pending row cannot outlive the send that made it.
 */
export const AGENT_CHAT_PENDING_ACCEPTED_TTL_MS = 30_000;

/**
 * Leading characters a projected message is matched on. A provider clips a long message, so the start is what survives.
 */
const MATCHED_PREFIX_LENGTH = 200;

function matchableText(text: string): string {
    return text.replaceAll(/\s+/gu, ' ').trim();
}

/**
 * Ids of the user messages and queue entries the projection holds.
 */
function agentChatPendingKnownIds(snapshot: AgentChatSnapshot | undefined): Set<string> {
    const userMessageIds = (snapshot?.items ?? []).flatMap((item) =>
        item.type === 'userMessage' ? [item.id] : [],
    );
    const queueIds = (snapshot?.queue ?? []).map((entry) => entry.id);
    return new Set([...userMessageIds, ...queueIds]);
}

/**
 * Where a message sent now lands, mirroring Server Core's `agentChat.send`: a steer joins a running turn; a running
 * turn, a compaction, earlier queued messages, or a message still on its way ahead of this one make it wait.
 */
export function agentChatPendingPlacement(
    snapshot: AgentChatSnapshot | undefined,
    delivery: 'queue' | 'steer' | undefined,
    hasPendingAhead: boolean,
): AgentChatPendingMessage['placement'] {
    if (delivery === 'steer' && snapshot?.activeTurnId) return 'timeline';
    const isMustWait =
        Boolean(snapshot?.activeTurnId) ||
        snapshot?.operation === 'compacting' ||
        ((snapshot?.queue?.length ?? 0) > 0 && !snapshot?.queuePaused);
    return isMustWait || hasPendingAhead ? 'queue' : 'timeline';
}

/**
 * Whether the projection now shows the message: a user message or queue entry it did not hold at send time whose text
 * carries the message's. Containment rather than equality, because the queue joins consecutive messages into one.
 */
export function isAgentChatPendingMessageSettled(
    pending: AgentChatPendingMessage,
    snapshot: AgentChatSnapshot | undefined,
): boolean {
    if (!snapshot) return false;
    const wanted = matchableText(pending.text).slice(0, MATCHED_PREFIX_LENGTH);
    const shown = [
        ...snapshot.items.flatMap((item) =>
            item.type === 'userMessage' ? [{ id: item.id, text: item.text }] : [],
        ),
        ...(snapshot.queue ?? []),
    ];
    return shown.some(
        (entry) => !pending.knownIds.has(entry.id) && matchableText(entry.text).includes(wanted),
    );
}

/**
 * Whether the projection settled an answer: the request left, or Server Core's own record of the answer arrived.
 */
export function isAgentChatPendingAnswerSettled(
    pending: AgentChatPendingAnswer,
    snapshot: AgentChatSnapshot | undefined,
): boolean {
    if (!snapshot) return false;
    return (
        snapshot.requests.every((request) => request.id !== pending.requestId) ||
        (pending.notice !== undefined &&
            snapshot.items.some((item) => item.id === pending.notice?.id))
    );
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
    updateMessages(terminalId, (current) =>
        current.some((message) => isAgentChatPendingMessageSettled(message, snapshot))
            ? current.filter((message) => !isAgentChatPendingMessageSettled(message, snapshot))
            : current,
    );
    updateAnswers(terminalId, (current) =>
        current.some((answer) => isAgentChatPendingAnswerSettled(answer, snapshot))
            ? current.filter((answer) => !isAgentChatPendingAnswerSettled(answer, snapshot))
            : current,
    );
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
        delivery: 'queue' | 'steer' | undefined;
    },
): string {
    const ahead = selectAgentChatPendingMessages(terminalId)(useAgentChatPendingStore.getState());
    const id = crypto.randomUUID();
    addAgentChatPendingMessage(terminalId, {
        id,
        text: message.text,
        images: message.images,
        placement: agentChatPendingPlacement(snapshot, message.delivery, ahead.length > 0),
        knownIds: agentChatPendingKnownIds(snapshot),
    });
    return id;
}

/**
 * Bounds an accepted message's pending row (see {@link AGENT_CHAT_PENDING_ACCEPTED_TTL_MS}); the projection showing it
 * usually drops the row long before.
 */
export function expireAgentChatPendingMessage(terminalId: string, id: string): void {
    setTimeout(
        () => dropAgentChatPendingMessage(terminalId, id),
        AGENT_CHAT_PENDING_ACCEPTED_TTL_MS,
    );
}
