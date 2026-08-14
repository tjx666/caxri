import { describe, expect, it } from 'vitest';

import { updateHeldMessagesAfterAction } from './agent-message-approval-state';

describe('held message approval state', () => {
    const heldMessages = [{ messageId: 'held-1' }, { messageId: 'held-2' }];

    it('keeps a held message retryable when the approve or deny request is rejected', () => {
        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', 'rejected')).toBe(
            heldMessages,
        );
    });

    it('removes a held message only after Host confirms its transition', () => {
        expect(updateHeldMessagesAfterAction(heldMessages, 'held-1', 'confirmed')).toEqual([
            { messageId: 'held-2' },
        ]);
    });
});
