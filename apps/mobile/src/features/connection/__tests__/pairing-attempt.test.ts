import { describe, expect, it } from 'vitest';

import { createPairingAttemptRegistry, runPairingAttempt } from '../pairing-attempt';

describe('pairing attempt ownership', () => {
    it('cancels the replaced attempt and keeps the replacement current', () => {
        const registry = createPairingAttemptRegistry();
        const first = registry.begin();
        const second = registry.begin();

        expect(first.signal.aborted).toBe(true);
        expect(registry.isCurrent(first)).toBe(false);
        expect(registry.isCurrent(second)).toBe(true);
    });

    it('does not let stale cleanup clear a newer attempt', () => {
        const registry = createPairingAttemptRegistry();
        const first = registry.begin();
        const second = registry.begin();

        registry.cancel(first);

        expect(first.signal.aborted).toBe(true);
        expect(registry.isCurrent(second)).toBe(true);
    });

    it('rolls back a result that becomes stale before handoff and rejects cancellation', async () => {
        const registry = createPairingAttemptRegistry();
        const attempt = registry.begin();
        let rollbackCount = 0;
        let isAdopted = false;

        await expect(
            runPairingAttempt({
                adopt: () => {
                    isAdopted = true;
                    return true;
                },
                attempt,
                cancellationError: () => new Error('Pairing was cancelled.'),
                isCurrent: () => registry.isCurrent(attempt),
                onComplete: () => {
                    throw new Error('stale result completed');
                },
                onPaired: () => {
                    throw new Error('stale result was handed off');
                },
                pair: () => {
                    registry.begin();
                    return Promise.resolve({ id: 'stale' });
                },
                rollback: () => {
                    rollbackCount += 1;
                    return Promise.resolve();
                },
            }),
        ).rejects.toThrow('Pairing was cancelled.');
        expect(rollbackCount).toBe(1);
        expect(isAdopted).toBe(false);
    });

    it('rejects when the connection cannot be adopted instead of reporting success', async () => {
        const registry = createPairingAttemptRegistry();
        const attempt = registry.begin();
        let pairedCount = 0;

        await expect(
            runPairingAttempt({
                adopt: () => false,
                attempt,
                cancellationError: () => new Error('Pairing was cancelled.'),
                isCurrent: () => registry.isCurrent(attempt),
                onComplete: () => {
                    throw new Error('unadopted result completed');
                },
                onPaired: () => {
                    pairedCount += 1;
                },
                pair: () => Promise.resolve({ id: 'unadopted' }),
                rollback: () => Promise.resolve(),
            }),
        ).rejects.toThrow('Pairing was cancelled.');
        expect(pairedCount).toBe(1);
    });
});
