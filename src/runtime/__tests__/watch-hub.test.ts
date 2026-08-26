import { CaxriError } from '@caxri/protocol';
import type parcelWatcher from '@parcel/watcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WatchHub } from '../watch-hub';

type SubscribeCallback = Parameters<typeof parcelWatcher.subscribe>[1];

function nativeSubscribe(unsubscribe = vi.fn(() => Promise.resolve())) {
    const callbacks: SubscribeCallback[] = [];
    const subscribe = vi.fn((_root: string, callback: SubscribeCallback) => {
        callbacks.push(callback);
        return Promise.resolve({ unsubscribe });
    }) as unknown as typeof parcelWatcher.subscribe;
    return { callbacks, subscribe, unsubscribe };
}

const failingSubscribe = (() =>
    Promise.reject(
        new Error('native backend unavailable'),
    )) as unknown as typeof parcelWatcher.subscribe;

describe('WatchHub', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('forwards native events and reports the registration in the snapshot', async () => {
        const { callbacks, subscribe } = nativeSubscribe();
        const hub = new WatchHub({ subscribe });
        const events: string[] = [];
        const handle = await hub.register({
            label: 'native-consumer',
            root: '/watched',
            onEvents: (batch) => events.push(...batch.map((event) => event.path)),
        });

        expect(handle.mode).toBe('native');
        callbacks[0]?.(null, [{ type: 'update', path: '/watched/file.ts' }]);
        expect(events).toEqual(['/watched/file.ts']);
        const snapshot = hub.snapshot();
        expect(snapshot).toMatchObject({ registrations: 1, native: 1, polling: 0, gateTrips: 0 });
        expect(snapshot.entries).toMatchObject([
            { label: 'native-consumer', native: 1, polling: 0, eventBatches: 1 },
        ]);
        await hub.close();
    });

    it('degrades to the polling fallback when the native subscription fails', async () => {
        const hub = new WatchHub({ subscribe: failingSubscribe });
        const activate = vi.fn();
        const pollOnce = vi.fn(() => Promise.resolve());
        const handle = await hub.register({
            label: 'degraded',
            root: '/watched',
            onEvents: () => {},
            fallback: { intervalMs: 100, activate, pollOnce },
        });

        expect(handle.mode).toBe('polling');
        await vi.advanceTimersByTimeAsync(250);
        expect(activate).toHaveBeenCalledOnce();
        expect(pollOnce).toHaveBeenCalledTimes(2);
        expect(activate.mock.invocationCallOrder[0]).toBeLessThan(
            pollOnce.mock.invocationCallOrder[0],
        );
        expect(hub.snapshot()).toMatchObject({ registrations: 1, native: 0, polling: 1 });
        await hub.close();
        await vi.advanceTimersByTimeAsync(500);
        expect(pollOnce).toHaveBeenCalledTimes(2);
    });

    it('waits for initial fallback activation before registration resolves', async () => {
        const activation = Promise.withResolvers<void>();
        const activate = vi.fn(() => activation.promise);
        const hub = new WatchHub({ subscribe: failingSubscribe });
        let isRegistrationSettled = false;
        const registration = hub.register({
            label: 'delayed-fallback',
            root: '/watched',
            onEvents: () => {},
            fallback: { intervalMs: 100, activate, pollOnce: () => Promise.resolve() },
        });
        const observeRegistration = async (): Promise<void> => {
            await registration;
            isRegistrationSettled = true;
        };
        const observation = observeRegistration();

        await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
        expect(isRegistrationSettled).toBe(false);
        activation.resolve();
        await observation;
        expect(isRegistrationSettled).toBe(true);
        await hub.close();
    });

    it('starts polling when initial fallback activation fails', async () => {
        const hub = new WatchHub({ subscribe: failingSubscribe });
        const pollOnce = vi.fn(() => Promise.resolve());
        const handle = await hub.register({
            label: 'failed-activation',
            root: '/watched',
            onEvents: () => {},
            fallback: {
                intervalMs: 100,
                activate: () => Promise.reject(new Error('baseline unavailable')),
                pollOnce,
            },
        });

        expect(handle.mode).toBe('polling');
        await vi.advanceTimersByTimeAsync(100);
        expect(pollOnce).toHaveBeenCalledOnce();
        await hub.close();
    });

    it('rethrows a native failure when no fallback exists and drops the registration', async () => {
        const hub = new WatchHub({ subscribe: failingSubscribe });
        await expect(
            hub.register({ label: 'no-fallback', root: '/watched', onEvents: () => {} }),
        ).rejects.toThrow('native backend unavailable');
        expect(hub.snapshot().registrations).toBe(0);
        await hub.close();
    });

    it('gates native subscriptions at the cap and degrades the overflow registration', async () => {
        const { subscribe } = nativeSubscribe();
        const hub = new WatchHub({ subscribe, maxNativeSubscriptions: 1 });
        const first = await hub.register({ label: 'first', root: '/a', onEvents: () => {} });
        expect(first.mode).toBe('native');

        const pollOnce = vi.fn(() => Promise.resolve());
        const second = await hub.register({
            label: 'second',
            root: '/b',
            onEvents: () => {},
            fallback: { intervalMs: 50, pollOnce },
        });
        expect(second.mode).toBe('polling');
        await vi.advanceTimersByTimeAsync(120);
        expect(pollOnce).toHaveBeenCalledTimes(2);

        await expect(
            hub.register({ label: 'third', root: '/c', onEvents: () => {} }),
        ).rejects.toThrow(CaxriError);
        expect(hub.snapshot().gateTrips).toBe(2);
        await hub.close();
    });

    it('shares one fallback timer per group and stops it when the last member leaves', async () => {
        const hub = new WatchHub({ subscribe: failingSubscribe });
        const pollOnce = vi.fn(() => Promise.resolve());
        const register = (label: string) =>
            hub.register({
                label,
                root: `/${label}`,
                onEvents: () => {},
                fallback: { groupKey: 'shared', intervalMs: 100, pollOnce },
            });
        const first = await register('member-a');
        const second = await register('member-b');

        await vi.advanceTimersByTimeAsync(210);
        // One shared timer: two ticks total, not two ticks per member.
        expect(pollOnce).toHaveBeenCalledTimes(2);

        await first.dispose();
        await vi.advanceTimersByTimeAsync(100);
        expect(pollOnce).toHaveBeenCalledTimes(3);

        await second.dispose();
        await vi.advanceTimersByTimeAsync(300);
        expect(pollOnce).toHaveBeenCalledTimes(3);
        await hub.close();
    });

    it('releases a native subscription that resolves after close', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const { promise, resolve } = Promise.withResolvers<{ unsubscribe: typeof unsubscribe }>();
        const subscribe = vi.fn(() => promise) as unknown as typeof parcelWatcher.subscribe;
        const hub = new WatchHub({ subscribe });

        const pending = hub.register({ label: 'late', root: '/watched', onEvents: () => {} });
        await hub.close();
        resolve({ unsubscribe });
        const handle = await pending;

        expect(handle.mode).toBe('disposed');
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('runs registered pollers on their interval until disposed', async () => {
        const hub = new WatchHub();
        const pollOnce = vi.fn(() => Promise.resolve());
        const handle = hub.registerPoller({ label: 'poller', intervalMs: 100, pollOnce });

        expect(handle.mode).toBe('polling');
        await vi.advanceTimersByTimeAsync(250);
        expect(pollOnce).toHaveBeenCalledTimes(2);
        expect(hub.snapshot().entries).toMatchObject([{ label: 'poller', polling: 1 }]);

        await handle.dispose();
        await vi.advanceTimersByTimeAsync(300);
        expect(pollOnce).toHaveBeenCalledTimes(2);
        expect(hub.snapshot().registrations).toBe(0);
        await hub.close();
    });

    it('skips overlapping poll ticks while one poll is still in flight', async () => {
        const hub = new WatchHub();
        const { promise, resolve } = Promise.withResolvers<void>();
        const pollOnce = vi.fn(() => promise);
        hub.registerPoller({ label: 'slow-poller', intervalMs: 100, pollOnce });

        await vi.advanceTimersByTimeAsync(350);
        expect(pollOnce).toHaveBeenCalledOnce();
        resolve();
        await vi.advanceTimersByTimeAsync(100);
        expect(pollOnce).toHaveBeenCalledTimes(2);
        await hub.close();
    });
});
