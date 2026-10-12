import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

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
    /**
     * How much of each projected entry earlier pending messages already took when they settled and left, so this one
     * cannot claim it again (see {@link settledAgentChatPendingMessages}).
     */
    claims?: ReadonlyMap<string, AgentChatPendingClaim>;
}

/**
 * How far into one projected entry's (normalized) text pending messages have been paired, and how many of its images.
 */
interface AgentChatPendingClaim {
    offset: number;
    images: number;
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
 * Leading characters a pending message is matched on. A provider clips a long message, so the start is what survives.
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

interface ProjectedEntry {
    id: string;
    text: string;
    images: number;
    /**
     * The timeline clipped its text at {@link MAX_AGENT_CHAT_TEXT_LENGTH}, so a message joined past the cut is missing.
     */
    isClipped: boolean;
}

function projectedEntries(snapshot: AgentChatSnapshot): ProjectedEntry[] {
    return [
        ...snapshot.items.flatMap((item) =>
            item.type === 'userMessage'
                ? [
                      {
                          id: item.id,
                          text: matchableText(item.text),
                          images: item.images?.length ?? 0,
                          isClipped: item.text.length >= MAX_AGENT_CHAT_TEXT_LENGTH,
                      },
                  ]
                : [],
        ),
        ...(snapshot.queue ?? []).map((entry) => ({
            id: entry.id,
            text: matchableText(entry.text),
            images: entry.imageCount ?? 0,
            isClipped: false,
        })),
    ];
}

/**
 * Where `message` landed in an entry, and whether it ran past the timeline's text bound there.
 */
interface AgentChatPendingPairing {
    entryId: string;
    claim: AgentChatPendingClaim;
    /**
     * The message's text runs past the clipped entry's end, so a message joined right after it is wholly cut off.
     */
    isPastCut: boolean;
}

/**
 * Where `message` lands in `entry` past what earlier messages took, or `undefined` when the entry does not carry it.
 * Text is matched on its leading characters (a provider clips a long message) at or after the claimed offset, so each
 * entry pairs with the messages it carries in order, at most once each: the queue joins consecutive messages into one,
 * but an earlier message that merely contains this one's text cannot also stand for it. An image-only message pairs on
 * its image count instead of matching an empty string. A message cut by the timeline's text bound pairs on the part
 * that survived.
 *
 * A message joined wholly past the cut leaves no text to match, so it pairs with the clipped entry only when
 * `isCutTail` says the message sent right before it ran past that entry's cut and both were queued; an empty surviving
 * fragment alone is no evidence, or every later message would settle against the clipped entry (issue #1894).
 */
function claimInEntry(
    message: AgentChatPendingMessage,
    entry: ProjectedEntry,
    claim: AgentChatPendingClaim,
    isCutTail: boolean,
): Omit<AgentChatPendingPairing, 'entryId'> | undefined {
    const imagesLeft = entry.images - claim.images;
    const images = claim.images + Math.min(message.images.length, Math.max(imagesLeft, 0));
    const full = matchableText(message.text);
    if (!full) {
        if (message.images.length === 0 || imagesLeft < message.images.length) return undefined;
        return { claim: { offset: claim.offset, images }, isPastCut: false };
    }
    const wanted = full.slice(0, MATCHED_PREFIX_LENGTH);
    const index = entry.text.indexOf(wanted, claim.offset);
    if (index !== -1) {
        const end = index + full.length;
        return {
            claim: { offset: Math.min(end, entry.text.length), images },
            isPastCut: entry.isClipped && end > entry.text.length,
        };
    }
    if (!entry.isClipped) return undefined;
    const rest = entry.text.slice(claim.offset).trim();
    const isCarried = rest ? wanted.startsWith(rest) : isCutTail && message.placement === 'queue';
    return isCarried
        ? { claim: { offset: entry.text.length, images }, isPastCut: true }
        : undefined;
}

/**
 * The claims the messages still pending carry from earlier ones that settled, merged to the furthest per entry.
 */
function carriedClaims(
    messages: readonly AgentChatPendingMessage[],
): Map<string, AgentChatPendingClaim> {
    const claims = new Map<string, AgentChatPendingClaim>();
    const carried = messages.flatMap((message) => [...(message.claims ?? [])]);
    for (const [id, claim] of carried) {
        const current = claims.get(id) ?? { offset: 0, images: 0 };
        claims.set(id, {
            offset: Math.max(claim.offset, current.offset),
            images: Math.max(claim.images, current.images),
        });
    }
    return claims;
}

/**
 * Pairs `message` with the first entry that carries it and records the claim. An entry its text shows in wins over the
 * cut tail of a clipped entry (`cutTailId`, see {@link claimInEntry}), since a message shown on its own was not joined.
 */
function pairMessage(
    message: AgentChatPendingMessage,
    entries: readonly ProjectedEntry[],
    claims: Map<string, AgentChatPendingClaim>,
    cutTailId: string | undefined,
): AgentChatPendingPairing | undefined {
    const candidates = entries.filter((entry) => !message.knownIds.has(entry.id));
    const pairIn = (entry: ProjectedEntry, isCutTail: boolean) => {
        const found = claimInEntry(
            message,
            entry,
            claims.get(entry.id) ?? { offset: 0, images: 0 },
            isCutTail,
        );
        return found && { entryId: entry.id, ...found };
    };
    const pairing =
        candidates.map((entry) => pairIn(entry, false)).find((found) => found !== undefined) ??
        candidates
            .filter((entry) => entry.id === cutTailId)
            .map((entry) => pairIn(entry, true))
            .find((found) => found !== undefined);
    if (pairing) claims.set(pairing.entryId, pairing.claim);
    return pairing;
}

/**
 * Ids of the pending messages the projection now shows, pairing each, in send order, with a user message or queue entry
 * it did not hold at send time (see {@link claimInEntry}). Also returns how much of each entry the pairing took, which
 * the messages that stay pending carry once the settled ones leave.
 */
function pairAgentChatPendingMessages(
    messages: readonly AgentChatPendingMessage[],
    snapshot: AgentChatSnapshot | undefined,
): { settled: Set<string>; claims: Map<string, AgentChatPendingClaim> } {
    const claims = carriedClaims(messages);
    if (!snapshot) return { settled: new Set(), claims };
    const entries = projectedEntries(snapshot);
    const settled = new Set<string>();
    /**
     * The clipped entry the previous queued message ran past the cut of, which a joined follower can only be in.
     */
    let cutTailId: string | undefined;
    for (const message of messages) {
        const pairing = pairMessage(message, entries, claims, cutTailId);
        if (pairing) settled.add(message.id);
        cutTailId =
            pairing?.isPastCut && message.placement === 'queue' ? pairing.entryId : undefined;
    }
    return { settled, claims };
}

/**
 * Ids of the pending messages the projection now shows; see {@link pairAgentChatPendingMessages}.
 */
export function settledAgentChatPendingMessages(
    messages: readonly AgentChatPendingMessage[],
    snapshot: AgentChatSnapshot | undefined,
): Set<string> {
    return pairAgentChatPendingMessages(messages, snapshot).settled;
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
    updateMessages(terminalId, (current) => {
        const { settled, claims } = pairAgentChatPendingMessages(current, snapshot);
        if (settled.size === 0) return current;
        return current
            .filter((message) => !settled.has(message.id))
            .map((message) => ({ ...message, claims }));
    });
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
