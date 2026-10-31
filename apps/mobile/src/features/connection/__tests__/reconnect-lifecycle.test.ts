import { describe, expect, it, vi } from 'vitest';

import { reconnectDelay } from '../connection-state';
import {
    countWhileDialing,
    foregroundRecoveryAction,
    hedgeSuspectConnection,
    observeMobileConnectionTermination,
    reconnectWaitForAttempt,
    retryAttemptAfterConnectionEnded,
    runReconnectAttempt,
    STABLE_CONNECTION_MS,
    terminationOutcome,
} from '../reconnect-lifecycle';
import { shouldScheduleMobileReconnect } from '../use-mobile-reconnect';

describe('mobile reconnect lifecycle', () => {
    it('treats a route upgrade as a planned hand-over, not a lost connection', () => {
        expect(terminationOutcome('route-upgrade')).toEqual({ kind: 'route-upgrade' });
        expect(terminationOutcome('disconnected')).toEqual({ kind: 'lost' });
        expect(terminationOutcome('revoked')).toEqual({ kind: 'revoked' });
    });

    it('schedules the first reconnect immediately and later retries with bounded backoff', () => {
        expect(reconnectWaitForAttempt(0, reconnectDelay)).toBe(0);
        expect(reconnectWaitForAttempt(1, reconnectDelay)).toBe(500);
        expect(reconnectWaitForAttempt(4, reconnectDelay)).toBe(4_000);
    });

    it('keeps backing off while each connection ends right after it was adopted', () => {
        // A screen that closed every connection on open used to reconnect at once until Server's admission limit hit.
        let attempt = 0;
        const waits: number[] = [];
        for (let index = 0; index < 4; index += 1) {
            attempt = retryAttemptAfterConnectionEnded(attempt, 1_000, 1_150);
            waits.push(reconnectWaitForAttempt(attempt, reconnectDelay));
        }
        expect(waits).toEqual([500, 1_000, 2_000, 4_000]);
    });

    it('reconnects at once after a connection that stayed up', () => {
        expect(retryAttemptAfterConnectionEnded(5, 1_000, 1_000 + STABLE_CONNECTION_MS)).toBe(0);
        expect(retryAttemptAfterConnectionEnded(5, 1_000, STABLE_CONNECTION_MS)).toBe(6);
    });

    it('only schedules a stored credential while the connection is stale', () => {
        const credential = { deviceId: 'device-1' } as never;
        expect(shouldScheduleMobileReconnect(credential, 'stale')).toBe(true);
        expect(shouldScheduleMobileReconnect(credential, 'connected')).toBe(false);
        expect(shouldScheduleMobileReconnect(null, 'stale')).toBe(false);
        expect(shouldScheduleMobileReconnect(credential, 'stale', false)).toBe(false);
    });

    it('closes a connection that resolves after its owner becomes inactive', async () => {
        const close = vi.fn();
        const onConnected = vi.fn();

        await runReconnectAttempt({
            connect: () => Promise.resolve({ close }),
            isActive: () => false,
            onConnected,
            onFailed: vi.fn(),
        });

        expect(close).toHaveBeenCalledOnce();
        expect(onConnected).not.toHaveBeenCalled();
    });

    it('reports a failed reconnect only while its owner is active', async () => {
        const onFailed = vi.fn();
        const failure = new Error('offline');
        await runReconnectAttempt({
            connect: () => Promise.reject(failure),
            isActive: () => true,
            onConnected: vi.fn(),
            onFailed,
        });
        expect(onFailed).toHaveBeenCalledExactlyOnceWith(failure);

        await runReconnectAttempt({
            connect: () => Promise.reject(new Error('offline')),
            isActive: () => false,
            onConnected: vi.fn(),
            onFailed,
        });
        expect(onFailed).toHaveBeenCalledOnce();
    });

    it('does not auto-retry terminal or unverified pairing states', () => {
        const credential = { deviceId: 'device-1' } as never;
        expect(shouldScheduleMobileReconnect(credential, 'revoked')).toBe(false);
        expect(shouldScheduleMobileReconnect(credential, 'unverified')).toBe(false);
        expect(shouldScheduleMobileReconnect(credential, 'version-mismatch')).toBe(false);
    });

    it('forces a fresh socket immediately after a long background interval', () => {
        expect(
            foregroundRecoveryAction({ backgroundedAt: 1_000, now: 11_001, hasConnection: true }),
        ).toBe('reconnect');
        expect(
            foregroundRecoveryAction({ backgroundedAt: 1_000, now: 10_999, hasConnection: true }),
        ).toBe('probe');
        expect(
            foregroundRecoveryAction({ backgroundedAt: 1_000, now: 2_000, hasConnection: false }),
        ).toBe('reconnect');
    });

    it('reports a connection that terminated before its owner subscribed', () => {
        const onTerminated = vi.fn();
        const unsubscribe = vi.fn();
        const observation = observeMobileConnectionTermination(
            {
                close: vi.fn(),
                onTermination: (listener) => {
                    listener('revoked');
                    return unsubscribe;
                },
            },
            onTerminated,
        );

        expect(observation.didTerminate).toBe(true);
        expect(observation.unsubscribe).toBe(unsubscribe);
        expect(onTerminated).toHaveBeenCalledExactlyOnceWith('revoked');
    });
});

describe('countWhileDialing', () => {
    it('counts an attempt only while it dials, including one that fails', async () => {
        const dialing = { current: 0 };
        const dial = Promise.withResolvers<undefined>();
        const attempt = countWhileDialing(dialing, () => dial.promise);
        expect(dialing.current).toBe(1);
        dial.resolve(undefined);
        await attempt;
        expect(dialing.current).toBe(0);

        await expect(
            countWhileDialing(dialing, () => Promise.reject(new Error('dial failed'))),
        ).rejects.toThrow('dial failed');
        expect(dialing.current).toBe(0);
    });
});

describe('suspect connection hedge', () => {
    const suspectFixture = () => {
        const listeners = new Set<() => void>();
        return {
            observe: () => {
                for (const listener of listeners) listener();
            },
            suspect: {
                onObservation: (listener: () => void) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            listenerCount: () => listeners.size,
        };
    };

    it('keeps a slow connection that answers before its replacement is ready', async () => {
        const fixture = suspectFixture();
        const replacement = { close: vi.fn() };
        const { promise, resolve } = Promise.withResolvers<typeof replacement>();
        const onReplaced = vi.fn();
        const outcome = hedgeSuspectConnection({
            connect: () => promise,
            isCurrent: () => true,
            onReplaced,
            suspect: fixture.suspect,
        });
        expect(fixture.listenerCount()).toBe(1);
        fixture.observe();
        resolve(replacement);
        await expect(outcome).resolves.toBe('kept');
        expect(onReplaced).not.toHaveBeenCalled();
        expect(replacement.close).toHaveBeenCalledExactlyOnceWith('superseded');
        expect(fixture.listenerCount()).toBe(0);
    });

    it('adopts the replacement when the suspect stays silent', async () => {
        const fixture = suspectFixture();
        const replacement = { close: vi.fn() };
        const onReplaced = vi.fn();
        await expect(
            hedgeSuspectConnection({
                connect: () => Promise.resolve(replacement),
                isCurrent: () => true,
                onReplaced,
                suspect: fixture.suspect,
            }),
        ).resolves.toBe('replaced');
        expect(onReplaced).toHaveBeenCalledExactlyOnceWith(replacement);
        expect(replacement.close).not.toHaveBeenCalled();
    });

    it('keeps the suspect when the replacement cannot connect', async () => {
        const fixture = suspectFixture();
        const onReplaced = vi.fn();
        await expect(
            hedgeSuspectConnection({
                connect: () => Promise.reject(new Error('Relay unavailable')),
                isCurrent: () => true,
                onReplaced,
                suspect: fixture.suspect,
            }),
        ).resolves.toBe('kept');
        expect(onReplaced).not.toHaveBeenCalled();
        expect(fixture.listenerCount()).toBe(0);
    });

    it('closes a replacement whose owner moved on to another connection', async () => {
        const fixture = suspectFixture();
        const replacement = { close: vi.fn() };
        const onReplaced = vi.fn();
        await expect(
            hedgeSuspectConnection({
                connect: () => Promise.resolve(replacement),
                isCurrent: () => false,
                onReplaced,
                suspect: fixture.suspect,
            }),
        ).resolves.toBe('kept');
        expect(onReplaced).not.toHaveBeenCalled();
        expect(replacement.close).toHaveBeenCalledExactlyOnceWith('superseded');
    });
});
