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
 * - Any → gone: {@link removeHeldMessage} (a receipt settled it elsewhere) or {@link expireHeldMessages} (the approval
 *   window ran out). Neither is an answer either.
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
    return { deferred, messages, ...(reviewing && { reviewing }) };
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
 * Drops a message that left the held state elsewhere (a receipt, another window, the sender withdrawing it).
 */
export function removeHeldMessage<T extends HeldMessageEntry>(
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
 * Drops every message whose approval window closed. Returning the same queue when nothing expired keeps the caller's
 * one-second tick from re-rendering the surfaces below it.
 */
export function expireHeldMessages<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    now: number,
): HeldMessageQueue<T> {
    if (queue.messages.every((message) => !(message.expiresAt <= now))) return queue;
    return withoutStaleReferences(
        queue.messages.filter((message) => message.expiresAt > now),
        queue,
    );
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
    };
}

/**
 * Brings a set-aside request back to the modal, ahead of queue order.
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
 */
export function settleHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
    messageId: string,
    result: HeldMessageActionResult,
): HeldMessageQueue<T> {
    return result === 'confirmed' || result === 'final-rejection'
        ? removeHeldMessage(queue, messageId)
        : queue;
}

/**
 * The single request the modal asks about: the one the user came back to, otherwise the oldest never set aside.
 */
export function activeHeldMessage<T extends HeldMessageEntry>(
    queue: HeldMessageQueue<T>,
): T | undefined {
    const deferred = new Set(queue.deferred);
    const reviewing =
        queue.reviewing && !deferred.has(queue.reviewing)
            ? queue.messages.find((message) => message.messageId === queue.reviewing)
            : undefined;
    return reviewing ?? queue.messages.find((message) => !deferred.has(message.messageId));
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
