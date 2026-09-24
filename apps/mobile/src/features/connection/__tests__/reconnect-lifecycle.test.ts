import { describe, expect, it, vi } from 'vitest';

import { reconnectDelay } from '../connection-state';
import {
    foregroundRecoveryAction,
    observeMobileConnectionTermination,
    reconnectWaitForAttempt,
    runReconnectAttempt,
} from '../reconnect-lifecycle';
import { shouldScheduleMobileReconnect } from '../use-mobile-reconnect';

describe('mobile reconnect lifecycle', () => {
    it('schedules the first reconnect immediately and later retries with bounded backoff', () => {
        expect(reconnectWaitForAttempt(0, reconnectDelay)).toBe(0);
        expect(reconnectWaitForAttempt(1, reconnectDelay)).toBe(500);
        expect(reconnectWaitForAttempt(4, reconnectDelay)).toBe(4_000);
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
