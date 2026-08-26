import type { AgentHeldMessageDetail } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    heldMessageActionResultForError,
    loadHeldMessageDetail,
    updateHeldMessagesAfterAction,
} from './agent-message-approval-state';

describe('held message approval state', () => {
    const heldMessages = [{ messageId: 'held-1' }, { messageId: 'held-2' }];

    it('keeps a held message retryable when the approve or deny request is rejected', () => {
        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', 'rejected')).toBe(
            heldMessages,
        );
    });

    it('removes a held message when Server says it no longer exists', () => {
        const result = heldMessageActionResultForError(
            new CaxriError('NOT_FOUND', 'Held Agent message was not found'),
        );

        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', result)).toEqual([
            { messageId: 'held-2' },
        ]);
    });

    it('keeps transient transport failures retryable', () => {
        expect(
            heldMessageActionResultForError(new CaxriError('UNAVAILABLE', 'Server is restarting')),
        ).toBe('rejected');
    });

    it('removes a held message only after Server confirms its transition', () => {
        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', 'confirmed')).toEqual([
            { messageId: 'held-2' },
        ]);
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
