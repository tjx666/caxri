import { CaxriError } from '@shared/ipc';
import { describe, expect, it } from 'vitest';

import {
    heldMessageActionResultForError,
    updateHeldMessagesAfterAction,
} from './agent-message-approval-state';

describe('held message approval state', () => {
    const heldMessages = [{ messageId: 'held-1' }, { messageId: 'held-2' }];

    it('keeps a held message retryable when the approve or deny request is rejected', () => {
        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', 'rejected')).toBe(
            heldMessages,
        );
    });

    it('removes a held message when Host says it no longer exists', () => {
        const result = heldMessageActionResultForError(
            new CaxriError('NOT_FOUND', 'Held Agent message was not found'),
        );

        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', result)).toEqual([
            { messageId: 'held-2' },
        ]);
    });

    it('keeps transient transport failures retryable', () => {
        expect(
            heldMessageActionResultForError(new CaxriError('UNAVAILABLE', 'Host is restarting')),
        ).toBe('rejected');
    });

    it('removes a held message only after Host confirms its transition', () => {
        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', 'confirmed')).toEqual([
            { messageId: 'held-2' },
        ]);
    });
});
