import type { AgentChatItem, AgentChatSnapshot } from './agent-chat-contract.js';

/**
 * Optimistic sends and answers, shared by the Desktop and phone Chats. Sending takes a round trip through Server Core
 * and, before the user message appears, the provider (Codex answers `turn/start` first, and a busy Chat serializes its
 * inputs), so a composer that waited for the projection read as ignoring the send. Each Client now shows the message at
 * once, where it is going to land, until the projection holds it; these rules decide where it lands and when the
 * projection has taken over. Each Client keeps its own store and its own image preview on top of them.
 */

/**
 * A message the user sent that the projection does not show yet.
 */
export interface AgentChatPendingMessageBase {
    id: string;
    text: string;
    /**
     * Where the message lands: the end of the timeline when it starts or steers a turn, the queue list when it waits.
     */
    placement: 'queue' | 'timeline';
    /**
     * User message and queue entry ids the projection held when the message was sent; only an entry outside them can be
     * this message.
     */
    knownIds: ReadonlySet<string>;
    /**
     * The projection's full queue length at send time (`queueLength`), for a bounded copy whose queue preview stops
     * before the end, where a message joining the queue never appears.
     */
    knownQueueLength?: number;
}

/**
 * A question answered whose request the projection still holds. Its card leaves at once and the answer shows in the
 * timeline, as Server Core will record it (`agentChatAnsweredNotice`).
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

/**
 * Characters a clipped entry must keep to identify a message on its own. Lower than `MATCHED_PREFIX_LENGTH` because the
 * phone clips the raw text before blank lines collapse, so the part it kept can collapse below that length.
 */
const MIN_CLIPPED_MATCH_LENGTH = 50;

/**
 * The marker a bounded copy of the projection (the phone's window and queue preview) puts where it cut a text.
 */
const CLIP_MARKER = '…';

function matchableText(text: string): string {
    return text.replaceAll(/\s+/gu, ' ').trim();
}

/**
 * The part of a text a bounded copy kept, when it was clipped at its start or end and what is left is long enough to
 * identify a message on its own; `undefined` for a whole text.
 */
function clippedPart(text: string): string | undefined {
    const isClipped = text.startsWith(CLIP_MARKER) || text.endsWith(CLIP_MARKER);
    if (!isClipped) return undefined;
    const kept = matchableText(text.replace(/^…/u, '').replace(/…$/u, ''));
    return kept.length >= MIN_CLIPPED_MATCH_LENGTH ? kept : undefined;
}

/**
 * The projection's full queue length, recorded with a send so a queue preview that stops early can still settle it.
 */
export function agentChatPendingKnownQueueLength(snapshot: AgentChatSnapshot | undefined): number {
    return snapshot?.queueLength ?? snapshot?.queue?.length ?? 0;
}

/**
 * Whether a queued message has joined a queue past the end of a bounded copy's preview, which can only show it as a
 * longer `queueLength`.
 */
function isQueuedPastPreview(
    pending: Pick<AgentChatPendingMessageBase, 'knownQueueLength' | 'placement'>,
    snapshot: AgentChatSnapshot,
): boolean {
    const shownLength = snapshot.queue?.length ?? 0;
    const fullLength = snapshot.queueLength ?? shownLength;
    return (
        pending.placement === 'queue' &&
        pending.knownQueueLength !== undefined &&
        fullLength > shownLength &&
        fullLength > pending.knownQueueLength
    );
}

/**
 * Ids of the user messages and queue entries the projection holds.
 */
export function agentChatPendingKnownIds(snapshot: AgentChatSnapshot | undefined): Set<string> {
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
): AgentChatPendingMessageBase['placement'] {
    if (delivery === 'steer' && snapshot?.activeTurnId) return 'timeline';
    const isMustWait =
        Boolean(snapshot?.activeTurnId) ||
        snapshot?.operation === 'compacting' ||
        ((snapshot?.queue?.length ?? 0) > 0 && !snapshot?.queuePaused);
    return isMustWait || hasPendingAhead ? 'queue' : 'timeline';
}

/**
 * Whether the projection now shows the message: a user message or queue entry it did not hold at send time whose text
 * carries the message's. Containment rather than equality, because the queue joins consecutive messages into one. A
 * bounded copy that clipped the entry (the phone keeps a long message's tail and a queued message's head) settles it
 * when the part it kept is part of the message, and a queue preview that stops before the end settles a queued message
 * once the full queue grew.
 */
export function isAgentChatPendingMessageSettled(
    pending: Pick<
        AgentChatPendingMessageBase,
        'knownIds' | 'knownQueueLength' | 'placement' | 'text'
    >,
    snapshot: AgentChatSnapshot | undefined,
): boolean {
    if (!snapshot) return false;
    if (isQueuedPastPreview(pending, snapshot)) return true;
    const sent = matchableText(pending.text);
    const wanted = sent.slice(0, MATCHED_PREFIX_LENGTH);
    const shown = [
        ...snapshot.items.flatMap((item) =>
            item.type === 'userMessage' ? [{ id: item.id, text: item.text }] : [],
        ),
        ...(snapshot.queue ?? []),
    ];
    return shown.some((entry) => {
        if (pending.knownIds.has(entry.id)) return false;
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- A substring search on strings, not an array lookup.
        if (matchableText(entry.text).includes(wanted)) return true;
        const kept = clippedPart(entry.text);
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- A substring search on strings, not an array lookup.
        return kept !== undefined && sent.includes(kept);
    });
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

/**
 * The pending messages the projection does not show yet. Returns the same array when none settled, so a store update
 * can bail out.
 */
export function unsettledAgentChatPendingMessages<Message extends AgentChatPendingMessageBase>(
    messages: readonly Message[],
    snapshot: AgentChatSnapshot | undefined,
): readonly Message[] {
    return messages.some((message) => isAgentChatPendingMessageSettled(message, snapshot))
        ? messages.filter((message) => !isAgentChatPendingMessageSettled(message, snapshot))
        : messages;
}

/**
 * The pending answers the projection has not settled yet. Returns the same array when none settled.
 */
export function unsettledAgentChatPendingAnswers(
    answers: readonly AgentChatPendingAnswer[],
    snapshot: AgentChatSnapshot | undefined,
): readonly AgentChatPendingAnswer[] {
    return answers.some((answer) => isAgentChatPendingAnswerSettled(answer, snapshot))
        ? answers.filter((answer) => !isAgentChatPendingAnswerSettled(answer, snapshot))
        : answers;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * What a Chat shows ahead of its projection: messages on their way, split by where they land, the answers whose record
 * has not arrived, and the requests already answered, whose cards leave at once. Anything the snapshot already shows is
 * left out, so a pending row and the real one never appear together.
 */
export function agentChatPendingView<Message extends AgentChatPendingMessageBase>(
    messages: readonly Message[],
    answers: readonly AgentChatPendingAnswer[],
    snapshot: AgentChatSnapshot | undefined,
): {
    timeline: Message[];
    queue: Message[];
    notices: AgentChatItem[];
    answeredRequestIds: ReadonlySet<string>;
} {
    const timeline: Message[] = [];
    const queue: Message[] = [];
    for (const message of unsettledAgentChatPendingMessages(messages, snapshot))
        (message.placement === 'queue' ? queue : timeline).push(message);
    const unsettled = unsettledAgentChatPendingAnswers(answers, snapshot);
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
}

/**
 * The composer draft after a message comes back to it (Edit on a queued message, or a send that failed): the message
 * alone when the composer is empty, otherwise the message ahead of what the user had typed, a blank line apart so the
 * two still read as separate paragraphs and neither is lost.
 */
export function agentChatDraftWithReturnedMessage(current: string, returned: string): string {
    if (!current.trim()) return returned;
    return `${returned}\n\n${current}`;
}
