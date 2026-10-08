import type { AgentHeldMessageDetail } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HeldMessageEntry, HeldMessageQueue } from './agent-message-approval-state';
import {
    acknowledgeExpiredHeldMessage,
    activeHeldMessage,
    deferHeldMessage,
    deferredHeldMessages,
    emptyHeldMessageQueue,
    expireHeldMessage,
    expireHeldMessages,
    heldMessageActionResultForError,
    loadHeldMessageDetail,
    presentedHeldMessage,
    receiveHeldMessage,
    removeHeldMessage,
    replaceHeldMessages,
    reviewHeldMessage,
    reviewOldestDeferredHeldMessage,
    settleHeldMessage,
} from './agent-message-approval-state';

const empty: HeldMessageQueue<HeldMessageEntry> = emptyHeldMessageQueue;

function held(messageId: string, createdAt: number): HeldMessageEntry {
    return { createdAt, expiresAt: createdAt + 300_000, messageId };
}

const first = held('held-1', 1_000);
const second = held('held-2', 2_000);

function queueOf(...messages: HeldMessageEntry[]): HeldMessageQueue<HeldMessageEntry> {
    return replaceHeldMessages(empty, messages);
}

describe('held message approval queue', () => {
    it('prompts for the oldest request and holds the rest back', () => {
        const queue = queueOf(second, first);

        expect(activeHeldMessage(queue)).toBe(first);
        expect(deferredHeldMessages(queue)).toEqual([]);
    });

    it('keeps a deferred request queued and unanswered instead of answering it', () => {
        const queue = deferHeldMessage(queueOf(first), 'held-1');

        // The message is still held, so the sender still reads "pending"; deferring is not a decision.
        expect(queue.messages).toEqual([first]);
        expect(activeHeldMessage(queue)).toBeUndefined();
        expect(deferredHeldMessages(queue)).toEqual([first]);
    });

    it('does not re-prompt a deferred request when the same held message arrives again', () => {
        const queue = receiveHeldMessage(deferHeldMessage(queueOf(first), 'held-1'), first);

        expect(activeHeldMessage(queue)).toBeUndefined();
        expect(deferredHeldMessages(queue)).toEqual([first]);
    });

    it('still prompts for a request that arrives after an unrelated deferral', () => {
        const queue = receiveHeldMessage(deferHeldMessage(queueOf(first), 'held-1'), second);

        expect(activeHeldMessage(queue)).toBe(second);
        expect(deferredHeldMessages(queue)).toEqual([first]);
    });

    it('returns to the reviewed request rather than the oldest one', () => {
        const bothDeferred = deferHeldMessage(
            deferHeldMessage(queueOf(first, second), 'held-1'),
            'held-2',
        );
        const queue = reviewHeldMessage(bothDeferred, 'held-2');

        expect(activeHeldMessage(queue)).toBe(second);
        expect(deferredHeldMessages(queue)).toEqual([first]);
    });

    it('reopens the request that has waited longest, whatever order it was set aside in', () => {
        const bothDeferred = deferHeldMessage(
            deferHeldMessage(queueOf(first, second), 'held-2'),
            'held-1',
        );
        const queue = reviewOldestDeferredHeldMessage(bothDeferred);

        expect(activeHeldMessage(queue)).toBe(first);
        expect(deferredHeldMessages(queue)).toEqual([second]);
    });

    it('leaves a queue with nothing set aside unchanged when asked to reopen the oldest', () => {
        const queue = queueOf(first, second);

        expect(reviewOldestDeferredHeldMessage(queue)).toBe(queue);
    });

    it('sets a reviewed request aside again without answering it', () => {
        const reviewing = reviewHeldMessage(deferHeldMessage(queueOf(first), 'held-1'), 'held-1');
        const queue = deferHeldMessage(reviewing, 'held-1');

        expect(queue.reviewing).toBeUndefined();
        expect(activeHeldMessage(queue)).toBeUndefined();
        expect(deferredHeldMessages(queue)).toEqual([first]);
    });

    it('expires a deferred request without recording it as a decision', () => {
        const deferred = deferHeldMessage(queueOf(first, second), 'held-1');
        const queue = expireHeldMessages(deferred, first.expiresAt);

        expect(queue.messages).toEqual([second]);
        expect(queue.deferred).toEqual([]);
        expect(deferredHeldMessages(queue)).toEqual([]);
    });

    it('keeps the request on screen, marked expired, when its window closes while it is being asked about', () => {
        const queue = expireHeldMessages(queueOf(first, second), first.expiresAt);

        // The Server no longer holds it, so it leaves the queue like any other expiry…
        expect(queue.messages).toEqual([second]);
        // …but the modal keeps showing it as void instead of vanishing under the reader.
        expect(presentedHeldMessage(queue)).toEqual({ isExpired: true, message: first });
    });

    it('does not swap the next request in under an expired notice until it is acknowledged', () => {
        const expired = expireHeldMessages(queueOf(first, second), first.expiresAt);

        expect(activeHeldMessage(expired)).toBeUndefined();
        const acknowledged = acknowledgeExpiredHeldMessage(expired);
        expect(presentedHeldMessage(acknowledged)).toEqual({ isExpired: false, message: second });
    });

    it('treats the Server expiry receipt for the presented request like the local tick', () => {
        const queue = expireHeldMessage(queueOf(first, second), 'held-1');

        expect(queue.messages).toEqual([second]);
        expect(presentedHeldMessage(queue)).toEqual({ isExpired: true, message: first });
        // Whichever of the two arrives second finds nothing left to expire.
        expect(expireHeldMessages(queue, first.expiresAt)).toBe(queue);
        expect(expireHeldMessage(queue, 'held-1')).toBe(queue);
    });

    it('lets a request set aside expire without an expired notice', () => {
        const deferred = deferHeldMessage(queueOf(first, second), 'held-1');

        expect(expireHeldMessage(deferred, 'held-1').expired).toBeUndefined();
        expect(expireHeldMessages(deferred, first.expiresAt).expired).toBeUndefined();
    });

    it('keeps the expired notice while other requests arrive, settle, or get set aside', () => {
        const third = held('held-3', 3_000);
        const expired = expireHeldMessages(queueOf(first, second), first.expiresAt);
        const queue = deferHeldMessage(
            removeHeldMessage(receiveHeldMessage(expired, third), 'held-2'),
            'held-3',
        );

        expect(queue.expired).toBe(first);
        expect(replaceHeldMessages(queue, [third]).expired).toBe(first);
    });

    it('drops the expired notice when the Server says the request was answered in time after all', () => {
        const expired = expireHeldMessages(queueOf(first, second), first.expiresAt);

        expect(settleHeldMessage(expired, 'held-1', 'confirmed').expired).toBeUndefined();
        expect(removeHeldMessage(expired, 'held-1').expired).toBeUndefined();
        // A final rejection is the Server agreeing the request is gone, so the notice stays.
        expect(settleHeldMessage(expired, 'held-1', 'final-rejection').expired).toBe(first);
    });

    it('clears the expired notice when the user picks a request from the waiting list', () => {
        const deferred = deferHeldMessage(queueOf(first, second), 'held-2');
        const expired = expireHeldMessages(deferred, first.expiresAt);
        const queue = reviewHeldMessage(expired, 'held-2');

        expect(presentedHeldMessage(queue)).toEqual({ isExpired: false, message: second });
    });

    it('leaves a queue without an expired notice unchanged on acknowledgement', () => {
        const queue = queueOf(first);

        expect(acknowledgeExpiredHeldMessage(queue)).toBe(queue);
    });

    it('leaves the queue untouched when the expiry tick finds nothing expired', () => {
        const queue = queueOf(first, second);

        expect(expireHeldMessages(queue, first.expiresAt - 1)).toBe(queue);
    });

    it('drops the deferral bookkeeping when the Server list no longer holds the message', () => {
        const deferred = deferHeldMessage(queueOf(first, second), 'held-1');

        expect(replaceHeldMessages(deferred, [second]).deferred).toEqual([]);
    });

    it('keeps a held message retryable when the approve or deny request is rejected', () => {
        const queue = queueOf(first, second);

        expect(settleHeldMessage(queue, 'held-1', 'rejected')).toBe(queue);
    });

    it('removes a held message when Server says it no longer exists', () => {
        const result = heldMessageActionResultForError(
            new CaxriError('NOT_FOUND', 'Held Agent message was not found'),
        );

        expect(settleHeldMessage(queueOf(first, second), 'held-1', result).messages).toEqual([
            second,
        ]);
    });

    it('keeps transient transport failures retryable', () => {
        expect(
            heldMessageActionResultForError(new CaxriError('UNAVAILABLE', 'Server is restarting')),
        ).toBe('rejected');
    });

    it('removes a held message only after Server confirms its transition', () => {
        const denied = settleHeldMessage(queueOf(first, second), 'held-1', 'confirmed');

        // A denial is an answer and leaves the queue; a deferral never does. The two stay distinguishable.
        expect(denied.messages).toEqual([second]);
        expect(denied.deferred).toEqual([]);
    });

    it('drops a message a receipt settled elsewhere, keeping the remaining deferral', () => {
        const deferred = deferHeldMessage(queueOf(first, second), 'held-1');
        const queue = removeHeldMessage(deferred, 'held-2');

        expect(queue.messages).toEqual([first]);
        expect(deferredHeldMessages(queue)).toEqual([first]);
    });

    it('treats a detail callback as stale when a decision wins while the request is pending', async () => {
        const completion = Promise.withResolvers<AgentHeldMessageDetail | null>();
        const onDetail = vi.fn();
        const onFailure = vi.fn();
        const onStale = vi.fn();
        const loading = loadHeldMessageDetail({
            isActive: () => true,
            onDetail,
            onFailure,
            onStale,
            request: () => completion.promise,
        });

        completion.resolve(null);
        await loading;

        expect(onStale).toHaveBeenCalledOnce();
        expect(onDetail).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('ignores a late detail callback after a receipt removes the active card', async () => {
        const completion = Promise.withResolvers<AgentHeldMessageDetail | null>();
        const onDetail = vi.fn();
        const onFailure = vi.fn();
        const onStale = vi.fn();
        let isActive = true;
        const loading = loadHeldMessageDetail({
            isActive: () => isActive,
            onDetail,
            onFailure,
            onStale,
            request: () => completion.promise,
        });

        isActive = false;
        completion.resolve({ messageId: 'held-1' } as AgentHeldMessageDetail);
        await loading;

        expect(onDetail).not.toHaveBeenCalled();
        expect(onStale).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
    });
});
