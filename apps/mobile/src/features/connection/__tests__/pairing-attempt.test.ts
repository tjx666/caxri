import { describe, expect, it } from 'vitest';

import { createPairingAttemptOwner } from '../pairing-attempt';

describe('pairing attempt ownership', () => {
    it('invalidates a late handshake after Back', () => {
        const owner = createPairingAttemptOwner();
        const first = owner.begin();
        expect(owner.cancel()).toBe(true);
        expect(first.isCurrent()).toBe(false);
        expect(first.signal.aborted).toBe(true);
        expect(owner.cancel()).toBe(false);
    });

    it('keeps replacement ownership when an older attempt finishes', () => {
        const owner = createPairingAttemptOwner();
        const first = owner.begin();
        const replacement = owner.begin();
        expect(first.signal.aborted).toBe(true);
        first.finish();
        expect(first.isCurrent()).toBe(false);
        expect(replacement.isCurrent()).toBe(true);
        expect(owner.cancel()).toBe(true);
        expect(replacement.isCurrent()).toBe(false);
    });

    it('invalidates the attempt when the device is forgotten', () => {
        const owner = createPairingAttemptOwner();
        const attempt = owner.begin();
        owner.invalidate();
        expect(attempt.isCurrent()).toBe(false);
    });
});
