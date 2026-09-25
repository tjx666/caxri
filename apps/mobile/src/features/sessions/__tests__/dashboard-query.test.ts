import { describe, expect, it, vi } from 'vitest';

import {
    dashboardPollInterval,
    dashboardQueryKey,
    isDashboardRouteVisible,
    readDashboardSnapshot,
    shouldObserveDashboard,
    startDashboardSubscription,
} from '../dashboard-query';

describe('mobile dashboard query lifecycle', () => {
    it('scopes cached dashboard data to the paired device generation', () => {
        const first = JSON.stringify(['host-1', 'device-1', 1]);
        const repaired = JSON.stringify(['host-1', 'device-1', 2]);
        const otherDevice = JSON.stringify(['host-1', 'device-2', 1]);
        expect(dashboardQueryKey(first)).not.toEqual(dashboardQueryKey(repaired));
        expect(dashboardQueryKey(first)).not.toEqual(dashboardQueryKey(otherDevice));
    });

    it('observes only the visible foreground host dashboard surface', () => {
        expect(isDashboardRouteVisible('/h/host-1', 'host-1')).toBe(true);
        expect(isDashboardRouteVisible('/h/host-1/s/session-1', 'host-1')).toBe(true);
        expect(isDashboardRouteVisible('/h/host-1/new', 'host-1')).toBe(true);
        expect(isDashboardRouteVisible('/h/host-2', 'host-1')).toBe(false);
        const eligible = {
            connectionScopeKey: 'scope-1',
            isForeground: true,
            status: 'connected' as const,
            visible: true,
        };
        expect(shouldObserveDashboard(eligible)).toBe(true);
        expect(shouldObserveDashboard({ ...eligible, isForeground: false })).toBe(false);
        expect(shouldObserveDashboard({ ...eligible, status: 'stale' })).toBe(false);
        expect(shouldObserveDashboard({ ...eligible, visible: false })).toBe(false);
        expect(shouldObserveDashboard({ ...eligible, connectionScopeKey: null })).toBe(false);
    });

    it('uses polling only while a visible connection has no subscription', () => {
        expect(dashboardPollInterval(true, 'active')).toBe(false);
        expect(dashboardPollInterval(true, 'pending')).toBe(false);
        expect(dashboardPollInterval(true, 'fallback')).toBe(2_500);
        expect(dashboardPollInterval(false, 'fallback')).toBe(false);
    });

    it('requests another snapshot when an event crosses an in-flight read', async () => {
        const { promise: read, resolve: resolveRead } = Promise.withResolvers<string>();
        let version = 0;
        const onConcurrentEvent = vi.fn();
        const snapshot = readDashboardSnapshot(
            () => read,
            () => version,
            onConcurrentEvent,
        );
        version += 1;
        resolveRead('snapshot');
        await expect(snapshot).resolves.toBe('snapshot');
        expect(onConcurrentEvent).toHaveBeenCalledOnce();
    });

    it('opens the dashboard read only after subscription acknowledgement', async () => {
        let acknowledge: (handle: { unsubscribe(): Promise<void> }) => void = () => {};
        let push: (event: { kind: string }) => void = () => {};
        const subscribe = vi.fn(
            (onEvent: (event: { kind: string }) => void) =>
                new Promise<{ unsubscribe(): Promise<void> }>((resolve) => {
                    acknowledge = resolve;
                    push = onEvent;
                }),
        );
        const onEvent = vi.fn();
        const onMode = vi.fn();
        const unsubscribe = vi.fn(async () => {});
        const stop = startDashboardSubscription(subscribe, onEvent, onMode, vi.fn());
        expect(onMode).not.toHaveBeenCalled();
        acknowledge({ unsubscribe });
        await vi.waitFor(() => expect(onMode).toHaveBeenLastCalledWith('active'));
        push({ kind: 'dashboard.changed' });
        expect(onEvent).toHaveBeenCalledOnce();
        stop();
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
        push({ kind: 'dashboard.changed' });
        expect(onEvent).toHaveBeenCalledOnce();
    });

    it('discards a late acknowledgement after leaving the view', async () => {
        let acknowledge: (handle: { unsubscribe(): Promise<void> }) => void = () => {};
        const onMode = vi.fn();
        const unsubscribe = vi.fn(async () => {});
        const stop = startDashboardSubscription(
            () => new Promise((resolve) => (acknowledge = resolve)),
            vi.fn(),
            onMode,
            vi.fn(),
        );
        stop();
        acknowledge({ unsubscribe });
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
        expect(onMode).not.toHaveBeenCalled();
    });

    it('enters polling fallback after a subscription failure', async () => {
        const onMode = vi.fn();
        startDashboardSubscription(
            () => Promise.reject(new Error('subscription unavailable')),
            vi.fn(),
            onMode,
            vi.fn(),
        );
        await vi.waitFor(() => expect(onMode).toHaveBeenLastCalledWith('fallback'));
    });

    it('falls back and requests resubscription when the Server drops a slow subscription', async () => {
        let push: (event: { kind: string }) => void = () => {};
        const onMode = vi.fn();
        const onResyncRequired = vi.fn();
        const onEvent = vi.fn();
        startDashboardSubscription(
            (listener) => {
                push = listener;
                return Promise.resolve({ unsubscribe: async () => {} });
            },
            onEvent,
            onMode,
            onResyncRequired,
        );
        await vi.waitFor(() => expect(onMode).toHaveBeenLastCalledWith('active'));
        push({ kind: 'resync-required' });
        expect(onEvent).toHaveBeenCalledOnce();
        expect(onMode).toHaveBeenLastCalledWith('fallback');
        expect(onResyncRequired).toHaveBeenCalledOnce();
        push({ kind: 'dashboard.changed' });
        expect(onEvent).toHaveBeenCalledOnce();
    });

    it('does not accept a subscription ACK after an earlier resync request', async () => {
        const onMode = vi.fn();
        const onResyncRequired = vi.fn();
        const unsubscribe = vi.fn(async () => {});
        const stop = startDashboardSubscription(
            (listener) => {
                listener({ kind: 'resync-required' });
                return Promise.resolve({ unsubscribe });
            },
            vi.fn(),
            onMode,
            onResyncRequired,
        );
        await vi.waitFor(() => expect(onResyncRequired).toHaveBeenCalledOnce());
        expect(onMode).toHaveBeenCalledOnce();
        expect(onMode).toHaveBeenLastCalledWith('fallback');
        stop();
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    });

    it('replaces the old subscription before reading after reconnect', async () => {
        const listeners: Array<(event: { kind: string }) => void> = [];
        const unsubscribe = vi.fn(async () => {});
        const subscribe = vi.fn((listener: (event: { kind: string }) => void) => {
            listeners.push(listener);
            return Promise.resolve({ unsubscribe });
        });
        const onEvent = vi.fn();
        const firstMode = vi.fn();
        const stopFirst = startDashboardSubscription(subscribe, onEvent, firstMode, vi.fn());
        await vi.waitFor(() => expect(firstMode).toHaveBeenLastCalledWith('active'));
        stopFirst();
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());

        const secondMode = vi.fn();
        const stopSecond = startDashboardSubscription(subscribe, onEvent, secondMode, vi.fn());
        await vi.waitFor(() => expect(secondMode).toHaveBeenLastCalledWith('active'));
        listeners[0]({ kind: 'dashboard.changed' });
        expect(onEvent).not.toHaveBeenCalled();
        listeners[1]({ kind: 'dashboard.changed' });
        expect(onEvent).toHaveBeenCalledOnce();
        stopSecond();
    });
});
