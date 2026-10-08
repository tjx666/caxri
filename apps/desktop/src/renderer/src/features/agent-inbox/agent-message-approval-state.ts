import type { AgentHeldMessageDetail } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import { sortBy } from 'es-toolkit';

export type HeldMessageActionResult = 'confirmed' | 'rejected' | 'final-rejection';

/**
 * The part of a held peer message this queue orders, expires, and identifies by. Keeping the shape minimal lets the
 * transitions be exercised without building a full protocol payload.
 */
export interface HeldMessageEntry {
    messageId: string;
    createdAt: number;
    expiresAt: number;
}

/**
 * Every held peer message the Server is still waiting on, plus which of them the user set aside.
 *
 * Deferring is deliberately not an answer. A request the user pushed aside stays in `messages` exactly as it was, so
 * the sender keeps reading "held" and the Agent keeps waiting; only the presentation changes from the blocking modal to
 * the waiting list. This mirrors VS Code, which keeps "the user said no" (`Denied`) and "nobody decided" (`Skipped`) as
 * separate reasons rather than collapsing a dismissal into a rejection.
 *
 * Transitions:
 *
 * - Queued → prompting: the oldest message that was never set aside is the one the modal asks about
 *   ({@link activeHeldMessage}); one request at a time, whatever the queue depth.
 * - Prompting → deferred: {@link deferHeldMessage} (Decide later, Escape, the close button, an outside click).
 * - Deferred → prompting: {@link reviewHeldMessage}, which also wins over queue order so the user returns to the request
 *   they picked rather than the oldest one. The status bar's count uses {@link reviewOldestDeferredHeldMessage}.
 * - Prompting → answered: {@link settleHeldMessage} with `confirmed` (Server accepted the approve or deny) or
 *   `final-rejection` (Server can no longer settle it); both drop the message.
 * - Prompting → prompting: {@link settleHeldMessage} with `rejected`, a transient transport failure the user can retry.
 * - Any → gone: {@link removeHeldMessage} (a receipt settled it elsewhere) or {@link expireHeldMessages} /
 *   {@link expireHeldMessage} (the approval window ran out). Neither is an answer either.
 * - Prompting → expired: when the window closes on the request the modal is asking about, it leaves `messages` like any
 *   other expiry but stays on screen as {@link HeldMessageQueue.expired} until {@link acknowledgeExpiredHeldMessage}. A
 *   request that expires while set aside only leaves the waiting list, which already shows its deadline.
 */
export interface HeldMessageQueue<T extends HeldMessageEntry> {
    readonly messages: readonly T[];
    /**
     * Message ids set aside with Decide later. They stay queued, unanswered, and visible in the waiting list.
     */
    readonly deferred: readonly string[];
    /**
     * A set-aside request the user explicitly came back to. It prompts ahead of queue order, so Review opens the row
     * that was clicked instead of the oldest unanswered request.
     */
    readonly reviewing?: string;
    /**
     * The request the modal was asking about when its approval window closed. The Server no longer holds it: it can be
     * neither approved nor denied, and it was not delivered; yet the modal keeps it on screen, marked expired, until
     * the user acknowledges that. Dropping it silently made the dialog vanish, or swap to the next queued request,
     * under a reader who was still deciding; the swap could even land a reflexive Approve on a message they never read.
     * While it is set, {@link activeHeldMessage} prompts for nothing else.
     */
    readonly expired?: T;
}

export const emptyHeldMessageQueue: HeldMessageQueue<never> = { deferred: [], messages: [] };

function orderByArrival<T extends HeldMessageEntry>(messages: readonly T[]): T[] {
    return sortBy(messages, [(message) => message.createdAt]);
}

/**
 * Drops bookkeeping for messages the queue no longer holds, so a long-lived window cannot accumulate ids for requests
 * that were answered or expired minutes ago.
 */
function withoutStaleReferences<T extends HeldMessageEntry>(
    messages: readonly T[],
    queue: HeldMessageQueue<T>,
): HeldMessageQueue<T> {
    const live = new Set(messages.map((message) => message.messageId));
    const deferred = queue.deferred.filter((messageId) => live.has(messageId));
    const reviewing = queue.reviewing && live.has(queue.reviewing) ? queue.reviewing : undefined;
    return {
        deferred,
        messages,
        ...(reviewing && { reviewing }),
        ...(queue.expired && { expired: queue.expired }),
    };
}

function withoutMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messageId: string,
): HeldMessageQueue<T> {
    if (queue.messages.every((message) => message.messageId !== messageId)) return queue;
    return withoutStaleReferences(
        queue.messages.filter((message) => message.messageId !== messageId),
        queue,
    );
}

/**
 * Drops the given expired requests, keeping the one the modal was presenting on screen as
 * {@link HeldMessageQueue.expired}.
 */
function withoutExpired<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    expiredIds: ReadonlySet<string>,
): HeldMessageQueue<T> {
    const presented = activeHeldMessage(queue);
    const next = withoutStaleReferences(
        queue.messages.filter((message) => !expiredIds.has(message.messageId)),
        queue,
    );
    return presented && expiredIds.has(presented.messageId)
        ? { ...next, expired: presented }
        : next;
}

/**
 * Replaces the queue with the Server's current held list, keeping any deferral that still applies.
 */
export function replaceHeldMessages<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messages: readonly T[],
): HeldMessageQueue<T> {
    return withoutStaleReferences(orderByArrival(messages), queue);
}

/**
 * Adds or refreshes one held message. A resent id keeps its deferral: the user already set that request aside, and
 * re-prompting for it would undo the decision they just made.
 */
export function receiveHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    incoming: T,
): HeldMessageQueue<T> {
    const next = queue.messages.filter((message) => message.messageId !== incoming.messageId);
    next.push(incoming);
    return { ...queue, messages: orderByArrival(next) };
}

/**
 * Drops a message that left the held state elsewhere (a receipt, another window, the sender withdrawing it). A receipt
 * that settles the request shown as expired means the Server answered it before the window closed after all, the local
 * tick only ran ahead of it, so the expired notice would now be wrong and goes too.
 */
export function removeHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messageId: string,
): HeldMessageQueue<T> {
    if (queue.expired?.messageId === messageId)
        return withoutMessage(acknowledgeExpiredHeldMessage(queue), messageId);
    return withoutMessage(queue, messageId);
}

/**
 * Drops every message whose approval window closed. Returning the same queue when nothing expired keeps the caller's
 * one-second tick from re-rendering the surfaces below it.
 */
export function expireHeldMessages<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    now: number,
): HeldMessageQueue<T> {
    const expired = queue.messages.filter((message) => message.expiresAt <= now);
    if (expired.length === 0) return queue;
    return withoutExpired(queue, new Set(expired.map((message) => message.messageId)));
}

/**
 * The Server's `expired` receipt for one message, which can arrive before the local tick notices.
 */
export function expireHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messageId: string,
): HeldMessageQueue<T> {
    if (queue.messages.every((message) => message.messageId !== messageId)) return queue;
    return withoutExpired(queue, new Set([messageId]));
}

/**
 * The user read the expired notice. The modal is free to ask about the next request, if any.
 */
export function acknowledgeExpiredHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
): HeldMessageQueue<T> {
    if (!queue.expired) return queue;
    return {
        deferred: queue.deferred,
        messages: queue.messages,
        ...(queue.reviewing && { reviewing: queue.reviewing }),
    };
}

/**
 * Sets a request aside without answering it. The message stays held and the sender stays pending.
 */
export function deferHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messageId: string,
): HeldMessageQueue<T> {
    if (queue.messages.every((message) => message.messageId !== messageId)) return queue;
    const wasDeferred = queue.deferred.includes(messageId);
    if (wasDeferred && queue.reviewing !== messageId) return queue;
    const reviewing = queue.reviewing === messageId ? undefined : queue.reviewing;
    return {
        deferred: wasDeferred ? queue.deferred : [...queue.deferred, messageId],
        messages: queue.messages,
        ...(reviewing && { reviewing }),
        ...(queue.expired && { expired: queue.expired }),
    };
}

/**
 * Brings a set-aside request back to the modal, ahead of queue order. Picking a request is also a clear sign the user
 * has moved past an expired notice, so it does not linger over the request they asked for.
 */
export function reviewHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messageId: string,
): HeldMessageQueue<T> {
    if (queue.messages.every((message) => message.messageId !== messageId)) return queue;
    return {
        deferred: queue.deferred.filter((deferredId) => deferredId !== messageId),
        messages: queue.messages,
        reviewing: messageId,
    };
}

/**
 * Brings back the set-aside request that has waited longest, which is what the status bar's count opens. A queue with
 * nothing set aside comes back unchanged.
 */
export function reviewOldestDeferredHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
): HeldMessageQueue<T> {
    const oldest = deferredHeldMessages(queue).at(0);
    return oldest ? reviewHeldMessage(queue, oldest.messageId) : queue;
}

/**
 * Non-retryable protocol failures mean the Server can no longer settle this held message. Retaining it would leave a
 * request in the queue whose only remaining actions repeat the same failure.
 */
export function heldMessageActionResultForError(error: unknown): HeldMessageActionResult {
    if (
        isCaxriError(error) &&
        ['NOT_FOUND', 'VALIDATION', 'FORBIDDEN', 'PATH_DENIED'].includes(error.code)
    )
        return 'final-rejection';
    return 'rejected';
}

/**
 * Retains a held message until Server confirms its transition. A rejected Desktop request can be a transient transport
 * failure, so removing it would leave the user unable to retry the decision.
 *
 * A confirmed answer to a request already shown as expired means the Server accepted it inside the window, so the
 * notice goes; a final rejection is the Server agreeing the request is gone, so the notice stays.
 */
export function settleHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messageId: string,
    result: HeldMessageActionResult,
): HeldMessageQueue<T> {
    if (result === 'confirmed') return removeHeldMessage(queue, messageId);
    if (result === 'final-rejection') return withoutMessage(queue, messageId);
    return queue;
}

/**
 * The single request the modal asks about: the one the user came back to, otherwise the oldest never set aside. Nothing
 * while an expired notice is still on screen.
 */
export function activeHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
): T | undefined {
    if (queue.expired) return undefined;
    const deferred = new Set(queue.deferred);
    const reviewing =
        queue.reviewing && !deferred.has(queue.reviewing)
            ? queue.messages.find((message) => message.messageId === queue.reviewing)
            : undefined;
    return reviewing ?? queue.messages.find((message) => !deferred.has(message.messageId));
}

/**
 * What the modal shows: the expired notice until it is acknowledged, otherwise the request it asks about.
 */
export function presentedHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
): { isExpired: boolean; message: T } | undefined {
    if (queue.expired) return { isExpired: true, message: queue.expired };
    const active = activeHeldMessage(queue);
    return active && { isExpired: false, message: active };
}

/**
 * The wall-clock time an approval window closes, as every approval surface prints it.
 */
export function heldMessageDeadlineLabel(expiresAt: number): string {
    return new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The set-aside requests, in arrival order, for the non-blocking waiting list.
 */
export function deferredHeldMessages<T extends HeldMessageEntry>(queue: HeldMessageQueue<T>): T[] {
    const deferred = new Set(queue.deferred);
    return queue.messages.filter((message) => deferred.has(message.messageId));
}

interface LoadHeldMessageDetailOptions {
    isActive: () => boolean;
    onDetail: (detail: AgentHeldMessageDetail) => void;
    onFailure: (error: unknown) => void;
    onStale: () => void;
    request: () => Promise<AgentHeldMessageDetail | null>;
}

/**
 * Reconciles an in-flight detail request with a receipt or decision that can remove the same held message first.
 * Keeping the active check beside the nullable Server result makes both callback orders deterministic and testable.
 */
export async function loadHeldMessageDetail({
    isActive,
    onDetail,
    onFailure,
    onStale,
    request,
}: LoadHeldMessageDetailOptions): Promise<void> {
    try {
        const detail = await request();
        if (!isActive()) return;
        if (detail) onDetail(detail);
        else onStale();
    } catch (error) {
        if (isActive()) onFailure(error);
    }
}
