import { describe, expect, it, vi } from 'vitest';

import { reconnectDelay } from '../connection-state';
import { reconnectWaitForAttempt, runReconnectAttempt } from '../reconnect-lifecycle';
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
        await runReconnectAttempt({
            connect: () => Promise.reject(new Error('offline')),
            isActive: () => true,
            onConnected: vi.fn(),
            onFailed,
        });
        expect(onFailed).toHaveBeenCalledOnce();

        await runReconnectAttempt({
            connect: () => Promise.reject(new Error('offline')),
            isActive: () => false,
            onConnected: vi.fn(),
            onFailed,
        });
        expect(onFailed).toHaveBeenCalledOnce();
    });
});
