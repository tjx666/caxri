// oxlint-disable typescript/require-await -- Async request fakes preserve the production Promise boundary.
import { describe, expect, it, vi } from 'vitest';

import {
    agentChatQueueCardLayout,
    agentChatQueueEditMode,
    agentChatQueueEntries,
    agentChatQueueErrorMessage,
    agentChatQueueFailure,
    agentChatQueueHeader,
    agentChatQueueImagesAttached,
    agentChatQueueRowHints,
    canSaveAgentChatQueueEdit,
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
    const removeError = { id: 'a', message: agentChatQueueErrorMessage('remove') };
    const resumeError = { message: agentChatQueueErrorMessage('resume') };

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
        const reportError = vi.fn<(message: string | null, failure?: string) => void>();
        const run = (action: 'remove' | 'sendNow' | 'edit') =>
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
        expect(remove.reportError).toHaveBeenLastCalledWith(
            agentChatQueueErrorMessage('remove'),
            'other',
        );
        const steer = harness(failing);
        await steer.run('sendNow');
        expect(steer.reportError).toHaveBeenLastCalledWith(
            agentChatQueueErrorMessage('sendNow'),
            'other',
        );
    });

    it('tells an Edit whose message already left the queue apart from one worth retrying', async () => {
        const refusing = (code: string) =>
            harness(async () => {
                throw Object.assign(new Error('refused'), { code });
            });
        const gone = refusing('CONFLICT');
        await expect(gone.run('edit')).resolves.toBe(false);
        expect(gone.reportError).toHaveBeenLastCalledWith(
            agentChatQueueErrorMessage('edit'),
            'gone',
        );
        const tooLong = refusing('VALIDATION');
        await tooLong.run('edit');
        expect(tooLong.reportError).toHaveBeenLastCalledWith(
            agentChatQueueErrorMessage('edit'),
            'tooLong',
        );
        const offline = harness(async () => {
            throw new Error('offline');
        });
        await offline.run('edit');
        expect(offline.reportError).toHaveBeenLastCalledWith(
            agentChatQueueErrorMessage('edit'),
            'other',
        );
        expect(offline.hidden.has('a')).toBe(false);
    });
});

describe('agentChatQueueFailure', () => {
    it('reads a refusal as too long only for Edit, the one action that checks the phone send bound', () => {
        expect(agentChatQueueFailure('edit', 'VALIDATION')).toBe('tooLong');
        expect(agentChatQueueFailure('sendNow', 'VALIDATION')).toBe('other');
        expect(agentChatQueueFailure('remove', 'CONFLICT')).toBe('gone');
        expect(agentChatQueueFailure('edit', undefined)).toBe('other');
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

describe('agentChatQueueRowHints', () => {
    it('explains why a queued row cannot be sent or edited, and what Steer does', () => {
        const [text, images, , command] = agentChatQueueEntries(queue, true);
        expect(agentChatQueueRowHints(text)).toEqual({
            sendNow: 'Adds this message to the running turn now.',
            edit: undefined,
        });
        expect(agentChatQueueRowHints(images).edit).toBeUndefined();
        expect(agentChatQueueRowHints(command).sendNow).toBe(
            'A command waits for the running turn to end.',
        );
        const [, pending] = agentChatQueueEntries(queue.slice(0, 1), true, new Set(), [
            { id: 'p1', text: 'Then lint', imageUris: [] },
        ]);
        expect(agentChatQueueRowHints(pending)).toEqual({
            sendNow: 'Available once the message is queued.',
            edit: 'Available once the message is queued.',
        });
    });
});

describe('agentChatQueueCardLayout', () => {
    it('collapses to the header while composing until expanded, and always shows rows otherwise', () => {
        expect(agentChatQueueCardLayout({ isComposing: true, isExpanded: false })).toEqual({
            showsRows: false,
            showsToggle: true,
        });
        expect(agentChatQueueCardLayout({ isComposing: true, isExpanded: true })).toEqual({
            showsRows: true,
            showsToggle: true,
        });
        expect(agentChatQueueCardLayout({ isComposing: false, isExpanded: false })).toEqual({
            showsRows: true,
            showsToggle: false,
        });
    });
});

describe('queued message edit', () => {
    it('edits a message with images or references in place, and takes any other into the draft', () => {
        expect(agentChatQueueEditMode({ imageCount: 0, hasReferences: false })).toBe('draft');
        expect(agentChatQueueEditMode({ imageCount: 2, hasReferences: false })).toBe('inPlace');
        expect(agentChatQueueEditMode({ imageCount: 0, hasReferences: true })).toBe('inPlace');
    });

    it('refuses to save an emptied message unless images ride with it', () => {
        expect(canSaveAgentChatQueueEdit('  ', 0)).toBe(false);
        expect(canSaveAgentChatQueueEdit('', 1)).toBe(true);
        expect(canSaveAgentChatQueueEdit('fix it', 0)).toBe(true);
    });

    it('words the images note as Desktop does', () => {
        expect(agentChatQueueImagesAttached(1)).toBe('1 image attached');
        expect(agentChatQueueImagesAttached(3)).toBe('3 images attached');
    });
});
