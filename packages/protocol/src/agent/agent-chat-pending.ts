import type { AgentChatItem, AgentChatSnapshot } from './agent-chat-contract.js';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from './agent-chat-contract.js';
import type { AgentChatRequest } from './agent-chat-requests.js';

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
    /**
     * How many images the message carries; an image-only message pairs on this count instead of its empty text.
     */
    imageCount?: number;
    /**
     * How much of each projected entry earlier pending messages already took when they settled and left, so this one
     * cannot claim it again (see {@link pairAgentChatPendingMessages}).
     */
    claims?: ReadonlyMap<string, AgentChatPendingClaim>;
}

/**
 * How far into one projected entry's (normalized) text pending messages have been paired, and how many of its images.
 */
export interface AgentChatPendingClaim {
    offset: number;
    images: number;
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

interface ProjectedEntry {
    id: string;
    text: string;
    images: number;
    /**
     * The timeline clipped its text at {@link MAX_AGENT_CHAT_TEXT_LENGTH}, so a message joined past the cut is missing.
     */
    isClipped: boolean;
    /**
     * The part a bounded copy kept when it cut the text (see `clippedPart`).
     */
    kept: string | undefined;
}

function projectedEntries(snapshot: AgentChatSnapshot): ProjectedEntry[] {
    const entry = (id: string, text: string, images: number, isClipped: boolean) => ({
        id,
        text: matchableText(text),
        images,
        isClipped,
        kept: clippedPart(text),
    });
    return [
        ...snapshot.items.flatMap((item) =>
            item.type === 'userMessage'
                ? [
                      entry(
                          item.id,
                          item.text,
                          item.images?.length ?? 0,
                          item.text.length >= MAX_AGENT_CHAT_TEXT_LENGTH,
                      ),
                  ]
                : [],
        ),
        ...(snapshot.queue ?? []).map((queued) =>
            entry(queued.id, queued.text, queued.imageCount ?? 0, false),
        ),
    ];
}

/**
 * Where a message landed in an entry, and whether it ran past the timeline's text bound there.
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
 * that survived, and a bounded copy that clipped the entry (the phone keeps a long message's tail and a queued
 * message's head) pairs when the part it kept is part of the message.
 *
 * A message joined wholly past the timeline's cut leaves no text to match, so it pairs with the clipped entry only when
 * `isCutTail` says the message sent right before it ran past that entry's cut and both were queued; an empty surviving
 * fragment alone is no evidence, or every later message would settle against the clipped entry (issue #1894).
 */
function claimInEntry(
    message: AgentChatPendingMessageBase,
    entry: ProjectedEntry,
    claim: AgentChatPendingClaim,
    isCutTail: boolean,
): Omit<AgentChatPendingPairing, 'entryId'> | undefined {
    const imageCount = message.imageCount ?? 0;
    const imagesLeft = entry.images - claim.images;
    const images = claim.images + Math.min(imageCount, Math.max(imagesLeft, 0));
    const full = matchableText(message.text);
    if (!full) {
        if (imageCount === 0 || imagesLeft < imageCount) return undefined;
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
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- A substring search on strings, not an array lookup.
    if (claim.offset === 0 && entry.kept !== undefined && full.includes(entry.kept))
        return { claim: { offset: entry.text.length, images }, isPastCut: false };
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
    messages: readonly AgentChatPendingMessageBase[],
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
    message: AgentChatPendingMessageBase,
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
 * it did not hold at send time (see {@link claimInEntry}); a queue preview that stops before the end settles a queued
 * message once the full queue grew. Also returns how much of each entry the pairing took, which the messages that stay
 * pending carry once the settled ones leave.
 */
export function pairAgentChatPendingMessages(
    messages: readonly AgentChatPendingMessageBase[],
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
        if (pairing || isQueuedPastPreview(message, snapshot)) settled.add(message.id);
        cutTailId =
            pairing?.isPastCut && message.placement === 'queue' ? pairing.entryId : undefined;
    }
    return { settled, claims };
}

/**
 * Whether the projection now shows this one message, on its own; see {@link pairAgentChatPendingMessages}.
 */
export function isAgentChatPendingMessageSettled(
    pending: AgentChatPendingMessageBase,
    snapshot: AgentChatSnapshot | undefined,
): boolean {
    return pairAgentChatPendingMessages([pending], snapshot).settled.has(pending.id);
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
 * The pending messages the projection does not show yet, each carrying what the settled ones took (see
 * {@link pairAgentChatPendingMessages}). Returns the same array when none settled, so a store update can bail out.
 */
export function unsettledAgentChatPendingMessages<Message extends AgentChatPendingMessageBase>(
    messages: readonly Message[],
    snapshot: AgentChatSnapshot | undefined,
): readonly Message[] {
    const { settled, claims } = pairAgentChatPendingMessages(messages, snapshot);
    if (settled.size === 0) return messages;
    return messages
        .filter((message) => !settled.has(message.id))
        .map((message) => ({ ...message, claims }));
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
    /**
     * Question requests still waiting on their card, which the timeline marks with an Asking row.
     */
    asking: AgentChatRequest[];
} {
    const timeline: Message[] = [];
    const queue: Message[] = [];
    for (const message of unsettledAgentChatPendingMessages(messages, snapshot))
        (message.placement === 'queue' ? queue : timeline).push(message);
    const unsettled = unsettledAgentChatPendingAnswers(answers, snapshot);
    const answeredRequestIds =
        unsettled.length === 0 ? EMPTY_IDS : new Set(unsettled.map((answer) => answer.requestId));
    return {
        timeline,
        queue,
        notices: unsettled.flatMap((answer): AgentChatItem[] =>
            answer.notice ? [answer.notice] : [],
        ),
        answeredRequestIds,
        asking: (snapshot?.requests ?? []).filter(
            (request) => request.kind === 'question' && !answeredRequestIds.has(request.id),
        ),
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
