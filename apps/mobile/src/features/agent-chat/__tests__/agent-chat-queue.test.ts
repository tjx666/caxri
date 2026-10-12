// oxlint-disable typescript/require-await -- Async request fakes preserve the production Promise boundary.
import { describe, expect, it, vi } from 'vitest';

import {
    AGENT_CHAT_QUEUE_ERRORS,
    agentChatQueueEntries,
    agentChatQueueHeader,
    currentQueueError,
    didRunOptimisticQueueAction,
    prunePendingQueueIds,
} from '../agent-chat-queue';

const queue = [
    { id: 'a', text: 'Then run\n  the tests' },
    { id: 'b', text: 'Compare', imageCount: 2 },
    { id: 'c', text: '', imageCount: 1 },
    { id: 'd', text: '', command: { name: 'review', arguments: 'src' } },
    { id: 'e', text: '', command: { name: 'compact' } },
];

describe('agentChatQueueEntries', () => {
    it('ends the queue with messages still on their way, which cannot be sent now', () => {
        const rows = agentChatQueueEntries(queue.slice(0, 1), false, new Set(), [
            { id: 'p1', text: 'Then lint', imageUris: ['file:///a.jpg'] },
        ]);
        expect(rows.map(({ id, isPending }) => [id, isPending])).toEqual([
            ['a', undefined],
            ['p1', true],
        ]);
        expect(rows[1]).toMatchObject({ canSendNow: false, imageLabel: '1 image' });
    });

    it('lists the queue in send order, hiding entries whose delete or steer is still pending', () => {
        expect(agentChatQueueEntries(queue, false).map(({ id }) => id)).toEqual([
            'a',
            'b',
            'c',
            'd',
            'e',
        ]);
        expect(agentChatQueueEntries(queue, true, new Set(['a', 'd'])).map(({ id }) => id)).toEqual(
            ['b', 'c', 'e'],
        );
        expect(agentChatQueueEntries(undefined, false)).toEqual([]);
    });
});

describe('agentChatQueueHeader', () => {
    it('uses Desktop wording for a waiting, idle, and paused queue', () => {
        expect(agentChatQueueHeader({}, true, 0)).toBeUndefined();
        expect(agentChatQueueHeader({}, true, 2)).toEqual({
            title: 'Queued',
            count: 2,
            detail: 'sends after this turn',
            isPaused: false,
        });
        expect(agentChatQueueHeader({}, false, 1)).toMatchObject({
            title: 'Queued',
            detail: undefined,
        });
        expect(agentChatQueueHeader({ queuePaused: true }, false, 3)).toEqual({
            title: 'Queue paused',
            count: 3,
            detail: 'sends nothing until you resume',
            isPaused: true,
        });
    });

    it("counts every waiting message, including those past the phone's preview", () => {
        const preview = queue.slice(0, 2);
        expect(agentChatQueueHeader({ queue: preview, queueLength: 20 }, true, 2)?.count).toBe(20);
        // A row hidden while its delete is pending leaves the count; the rest past the preview stay.
        expect(agentChatQueueHeader({ queue: preview, queueLength: 20 }, true, 1)?.count).toBe(19);
        expect(agentChatQueueHeader({ queue: preview }, true, 2)?.count).toBe(2);
    });
});

describe('currentQueueError', () => {
    const removeError = { id: 'a', message: AGENT_CHAT_QUEUE_ERRORS.remove };
    const resumeError = { message: AGENT_CHAT_QUEUE_ERRORS.resume };

    it('keeps an error while its row is still queued, as the same object', () => {
        expect(currentQueueError(removeError, queue)).toBe(removeError);
        expect(currentQueueError(resumeError, queue)).toBe(resumeError);
        expect(currentQueueError(null, queue)).toBeNull();
    });

    it('drops an error once the queue empties, so the next queued message does not bring it back', () => {
        expect(currentQueueError(removeError, [])).toBeNull();
        expect(currentQueueError(resumeError, undefined)).toBeNull();
    });

    it("drops a row's error once that row has left the queue", () => {
        expect(currentQueueError(removeError, [{ id: 'next', text: 'Another' }])).toBeNull();
    });
});

describe('didRunOptimisticQueueAction', () => {
    const harness = (perform: (id: string) => Promise<void>) => {
        const hidden = new Set<string>();
        const reportError = vi.fn<(message: string | null) => void>();
        const run = (action: 'remove' | 'sendNow') =>
            didRunOptimisticQueueAction({
                action,
                hide: (id) => hidden.add(id),
                id: 'a',
                perform,
                reportError,
                reveal: (id) => hidden.delete(id),
            });
        return { hidden, reportError, run };
    };

    it('hides the row before the request and keeps it hidden once the Server accepts', async () => {
        let isHiddenDuringRequest = false;
        const { hidden, reportError, run } = harness(async () => {
            isHiddenDuringRequest = hidden.has('a');
        });
        await expect(run('remove')).resolves.toBe(true);
        expect(isHiddenDuringRequest).toBe(true);
        expect(hidden.has('a')).toBe(true);
        expect(reportError).toHaveBeenCalledWith(null);
        expect(reportError).toHaveBeenCalledTimes(1);
    });

    it('brings the row back with the action error when the Server refuses', async () => {
        const failing = async () => {
            throw new Error('CONFLICT');
        };
        const remove = harness(failing);
        await expect(remove.run('remove')).resolves.toBe(false);
        expect(remove.hidden.has('a')).toBe(false);
        expect(remove.reportError).toHaveBeenLastCalledWith(AGENT_CHAT_QUEUE_ERRORS.remove);
        const steer = harness(failing);
        await steer.run('sendNow');
        expect(steer.reportError).toHaveBeenLastCalledWith(AGENT_CHAT_QUEUE_ERRORS.sendNow);
    });
});

describe('prunePendingQueueIds', () => {
    it('forgets ids that left the queue and keeps the same set when nothing changed', () => {
        const pending = new Set(['a', 'gone']);
        expect([...prunePendingQueueIds(pending, queue)]).toEqual(['a']);
        const kept = new Set(['a']);
        expect(prunePendingQueueIds(kept, queue)).toBe(kept);
        expect(prunePendingQueueIds(kept, undefined).size).toBe(0);
    });
});
