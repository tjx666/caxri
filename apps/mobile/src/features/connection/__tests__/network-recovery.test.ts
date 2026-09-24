import { describe, expect, it, vi } from 'vitest';

import { mobileNetworkWakeAction, watchMobileNetwork } from '../network-recovery';

describe('mobile network recovery', () => {
    it('wakes only for a connected foreground network transition', () => {
        const network = { isConnected: true, type: 'CELLULAR' };
        expect(
            mobileNetworkWakeAction({
                network,
                isForeground: true,
                status: 'connected',
                hasOutstandingMutation: false,
            }),
        ).toBe('probe');
        expect(
            mobileNetworkWakeAction({
                network,
                isForeground: true,
                status: 'stale',
                hasOutstandingMutation: false,
            }),
        ).toBe('reconnect');
        expect(
            mobileNetworkWakeAction({
                network,
                isForeground: true,
                status: 'connected',
                hasOutstandingMutation: true,
            }),
        ).toBe('defer');
        expect(
            mobileNetworkWakeAction({
                network: { isConnected: false, type: 'NONE' },
                isForeground: true,
                status: 'connected',
                hasOutstandingMutation: false,
            }),
        ).toBe('ignore');
        expect(
            mobileNetworkWakeAction({
                network,
                isForeground: false,
                status: 'connected',
                hasOutstandingMutation: false,
            }),
        ).toBe('ignore');
        expect(
            mobileNetworkWakeAction({
                network,
                isForeground: true,
                status: 'version-mismatch',
                hasOutstandingMutation: false,
            }),
        ).toBe('ignore');
    });

    it('removes the native listener and ignores callbacks after cleanup', () => {
        let listener: ((state: { isConnected?: boolean; type?: string }) => void) | undefined;
        const remove = vi.fn();
        const onAction = vi.fn();
        const stop = watchMobileNetwork({
            subscribe: (callback) => {
                listener = callback;
                return { remove };
            },
            context: () => ({
                isForeground: true,
                status: 'connected',
                hasOutstandingMutation: false,
            }),
            onAction,
        });

        expect(listener).toBeTypeOf('function');
        listener?.({ isConnected: true, type: 'WIFI' });
        expect(onAction).toHaveBeenCalledExactlyOnceWith('probe');
        stop();
        expect(remove).toHaveBeenCalledOnce();
        listener?.({ isConnected: true, type: 'CELLULAR' });
        expect(onAction).toHaveBeenCalledOnce();
    });
});
