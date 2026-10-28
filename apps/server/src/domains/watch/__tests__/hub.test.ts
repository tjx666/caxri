import { CaxriError } from '@caxri/protocol';
import type parcelWatcher from '@parcel/watcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WatchHub } from '../hub';

function metricLogger() {
    const recordMetric = vi.fn();
    return { logger: { recordMetric } as never, recordMetric };
}

function writeLogger() {
    const write = vi.fn<(level: string, event: string, options?: unknown) => void>();
    const recordMetric = vi.fn();
    return { logger: { recordMetric, write } as never, write };
}

const MUST_RESCAN_MESSAGE =
    'Events were dropped by the FSEvents client. File system must be re-scanned.';

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

    it('records a bounded watcher census without labels or paths', async () => {
        const { logger, recordMetric } = metricLogger();
        const hub = new WatchHub({ logger, subscribe: nativeSubscribe().subscribe });
        const handle = await hub.register({
            label: 'safe-label',
            root: '/secret/project',
            onEvents: () => {},
        });

        expect(recordMetric).toHaveBeenLastCalledWith('watcher.count', 1, {
            owner: 'server-core',
            phase: 'runtime',
            outcome: 'success',
        });
        expect(JSON.stringify(recordMetric.mock.calls)).not.toContain('/secret/project');
        await handle.dispose();
        expect(recordMetric).toHaveBeenLastCalledWith('watcher.count', 0, {
            owner: 'server-core',
            phase: 'runtime',
            outcome: 'success',
        });
        await hub.close();
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

    it('keeps close pending until an in-flight native subscription is released', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const { promise, resolve } = Promise.withResolvers<parcelWatcher.AsyncSubscription>();
        const subscribe = vi.fn(() => promise) as unknown as typeof parcelWatcher.subscribe;
        const hub = new WatchHub({ subscribe });
        const registration = hub.register({ label: 'late', root: '/watched', onEvents: () => {} });
        let isClosed = false;
        const closing = (async () => {
            await hub.close();
            isClosed = true;
        })();

        await vi.advanceTimersByTimeAsync(0);
        expect(isClosed).toBe(false);
        resolve({ unsubscribe });
        await closing;
        expect(unsubscribe).toHaveBeenCalledOnce();
        await expect(registration).resolves.toMatchObject({ mode: 'disposed' });
    });

    it('keeps close pending until a fallback-released native subscription finishes', async () => {
        const { promise, resolve } = Promise.withResolvers<undefined>();
        const { subscribe, unsubscribe } = nativeSubscribe(vi.fn(() => promise));
        const hub = new WatchHub({ subscribe });
        const handle = await hub.register({
            label: 'degrading',
            root: '/watched',
            onEvents: () => {},
            fallback: { intervalMs: 100, pollOnce: () => Promise.resolve() },
        });
        handle.startFallback(new CaxriError('UNAVAILABLE', 'native backend lost'));
        await vi.advanceTimersByTimeAsync(0);
        expect(unsubscribe).toHaveBeenCalledOnce();
        let isClosed = false;
        const closing = (async () => {
            await hub.close();
            isClosed = true;
        })();

        await vi.advanceTimersByTimeAsync(0);
        expect(isClosed).toBe(false);
        resolve(undefined);
        await closing;
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

    it('keeps a must-rescan advisory native, running one rescan instead of falling back', async () => {
        const { callbacks, subscribe } = nativeSubscribe();
        const { logger, write } = writeLogger();
        const hub = new WatchHub({ subscribe, logger });
        const onError = vi.fn();
        const onRescan = vi.fn();
        const activate = vi.fn();
        const pollOnce = vi.fn(() => Promise.resolve());
        const handle = await hub.register({
            label: 'rescan-consumer',
            root: '/watched',
            onEvents: () => {},
            onError,
            onRescan,
            fallback: { intervalMs: 100, activate, pollOnce },
        });
        expect(handle.mode).toBe('native');

        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), []);

        expect(onRescan).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
        expect(handle.mode).toBe('native');
        await vi.advanceTimersByTimeAsync(500);
        expect(activate).not.toHaveBeenCalled();
        expect(pollOnce).not.toHaveBeenCalled();
        const events = write.mock.calls.map((call) => call[1]);
        expect(events).toContain('watch_hub.rescan');
        expect(events).not.toContain('watch_hub.fallback');
        expect(events).not.toContain('watch_hub.watcher_error');
        await hub.close();
    });

    it('forwards events bundled with a must-rescan advisory instead of discarding them', async () => {
        const { callbacks, subscribe } = nativeSubscribe();
        const hub = new WatchHub({ subscribe });
        const events: string[] = [];
        await hub.register({
            label: 'rescan-with-events',
            root: '/watched',
            onEvents: (batch) => events.push(...batch.map((event) => event.path)),
            onRescan: () => {},
        });

        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), [
            { type: 'update', path: '/watched/file.ts' },
        ]);

        expect(events).toEqual(['/watched/file.ts']);
        expect(hub.snapshot().entries).toMatchObject([
            { label: 'rescan-with-events', native: 1, eventBatches: 1 },
        ]);
        await hub.close();
    });

    /**
     * Writes denser than `@parcel/watcher`'s 50ms debounce make it force a batch out on its 500ms ceiling for as long
     * as they last, so advisories arrive at that cadence rather than once per real overflow.
     */
    it('coalesces a dense advisory stream into one reconcile per throttle window', async () => {
        const { callbacks, subscribe } = nativeSubscribe();
        const { logger, write } = writeLogger();
        const hub = new WatchHub({ subscribe, logger });
        const onRescan = vi.fn();
        await hub.register({
            label: 'rescan-throttle',
            root: '/watched',
            onEvents: () => {},
            onRescan,
        });

        for (let advisory = 0; advisory < 6; advisory += 1) {
            callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), []);
            // eslint-disable-next-line no-await-in-loop -- the 500ms arrival cadence is the behavior under test
            await vi.advanceTimersByTimeAsync(500);
        }

        // The first advisory reconciles immediately; the remaining five collapse into one reconcile per 1000ms window.
        expect(onRescan).toHaveBeenCalledTimes(4);
        const advisoryCounts = write.mock.calls
            .filter((call) => call[1] === 'watch_hub.rescan')
            .map((call) => (call[2] as { fields: { advisoryCount: number } }).fields.advisoryCount);
        expect(advisoryCounts).toEqual([1, 1, 2, 2]);
        await hub.close();
    });

    it('still forwards events carried by an advisory that the throttle window coalesces', async () => {
        const { callbacks, subscribe } = nativeSubscribe();
        const hub = new WatchHub({ subscribe });
        const events: string[] = [];
        const onRescan = vi.fn();
        await hub.register({
            label: 'rescan-coalesced-events',
            root: '/watched',
            onEvents: (batch) => events.push(...batch.map((event) => event.path)),
            onRescan,
        });

        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), []);
        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), [
            { type: 'update', path: '/watched/second.ts' },
        ]);

        expect(onRescan).toHaveBeenCalledOnce();
        expect(events).toEqual(['/watched/second.ts']);
        await hub.close();
    });

    it('stops the throttle window when the registration degrades to its polling fallback', async () => {
        const { callbacks, subscribe } = nativeSubscribe();
        const hub = new WatchHub({ subscribe });
        const onRescan = vi.fn();
        const handle = await hub.register({
            label: 'rescan-fallback',
            root: '/watched',
            onEvents: () => {},
            onRescan,
            fallback: { intervalMs: 10_000, pollOnce: () => {} },
        });

        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), []);
        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), []);
        handle.startFallback(new CaxriError('UNAVAILABLE', 'native backend lost'));
        await vi.advanceTimersByTimeAsync(2000);

        // The poll loop owns reconciliation once native is gone; the coalesced advisory must not add one more.
        expect(handle.mode).toBe('polling');
        expect(onRescan).toHaveBeenCalledOnce();
        await hub.close();
    });

    it('stops the throttle window when the registration is disposed mid-stream', async () => {
        const { callbacks, subscribe } = nativeSubscribe();
        const hub = new WatchHub({ subscribe });
        const onRescan = vi.fn();
        const handle = await hub.register({
            label: 'rescan-dispose',
            root: '/watched',
            onEvents: () => {},
            onRescan,
        });

        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), []);
        callbacks[0]?.(new Error(MUST_RESCAN_MESSAGE), []);
        await handle.dispose();
        await vi.advanceTimersByTimeAsync(5000);

        expect(onRescan).toHaveBeenCalledOnce();
        await hub.close();
    });

    it('retries a fallback-degraded native subscription with exponential backoff and restores native mode', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const callbacks: SubscribeCallback[] = [];
        let attempt = 0;
        const subscribe = vi.fn((_root: string, callback: SubscribeCallback) => {
            attempt += 1;
            if (attempt <= 2) return Promise.reject(new Error('native backend unavailable'));
            callbacks.push(callback);
            return Promise.resolve({ unsubscribe });
        }) as unknown as typeof parcelWatcher.subscribe;
        const { logger, write } = writeLogger();
        const hub = new WatchHub({ subscribe, logger });
        const pollOnce = vi.fn(() => Promise.resolve());
        const handle = await hub.register({
            label: 'flaky',
            root: '/watched',
            onEvents: () => {},
            fallback: { intervalMs: 100, pollOnce },
        });

        expect(handle.mode).toBe('polling');
        expect(subscribe).toHaveBeenCalledOnce();

        // First retry fires at the initial 5s delay and still fails.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(handle.mode).toBe('polling');

        // The next retry backs off to 10s (delay doubled) before succeeding.
        await vi.advanceTimersByTimeAsync(9_999);
        expect(subscribe).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribe).toHaveBeenCalledTimes(3);
        expect(handle.mode).toBe('native');
        expect(write.mock.calls.map((call) => call[1])).toContain('watch_hub.native_restored');

        // The poll timer stopped: no further pollOnce ticks once native mode is restored.
        const pollCallsAtRestore = pollOnce.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pollOnce).toHaveBeenCalledTimes(pollCallsAtRestore);
        await hub.close();
    });

    it('raises a limit alert when inotify watches run out and clears it once native watching returns', async () => {
        const limitError = new Error(
            "inotify_add_watch on '/watched/a' failed: No space left on device",
        );
        let attempt = 0;
        const subscribe = vi.fn(() => {
            attempt += 1;
            return attempt === 1
                ? Promise.reject(limitError)
                : Promise.resolve({ unsubscribe: () => Promise.resolve() });
        }) as unknown as typeof parcelWatcher.subscribe;
        const { logger, write } = writeLogger();
        const onLimitAlert = vi.fn();
        const hub = new WatchHub({ subscribe, logger, onLimitAlert });
        const handle = await hub.register({
            label: 'files-root',
            root: '/watched',
            onEvents: () => {},
            fallback: { intervalMs: 100, pollOnce: () => {} },
        });

        expect(handle.mode).toBe('polling');
        expect(onLimitAlert.mock.calls).toEqual([[{ state: 'raised', reason: 'watch-limit' }]]);
        const fallback = write.mock.calls.find((call) => call[1] === 'watch_hub.fallback');
        expect(fallback?.[2]).toMatchObject({ fields: { reason: 'watch-limit' } });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(handle.mode).toBe('native');
        expect(onLimitAlert).toHaveBeenLastCalledWith({ state: 'cleared' });
        await hub.close();
    });

    it('keeps the limit alert raised until the last limited watch goes away', async () => {
        const subscribe = vi.fn((root: string) =>
            Promise.reject(
                new Error(
                    root === '/other'
                        ? 'Unable to initialize inotify: Too many open files'
                        : 'native backend unavailable',
                ),
            ),
        ) as unknown as typeof parcelWatcher.subscribe;
        const onLimitAlert = vi.fn();
        const hub = new WatchHub({ subscribe, onLimitAlert });
        const fallback = { intervalMs: 100, pollOnce: () => {} };
        const unrelated = await hub.register({
            label: 'a',
            root: '/gone',
            onEvents: () => {},
            fallback,
        });
        expect(onLimitAlert).not.toHaveBeenCalled();
        const first = await hub.register({
            label: 'b',
            root: '/other',
            onEvents: () => {},
            fallback,
        });
        const second = await hub.register({
            label: 'c',
            root: '/other',
            onEvents: () => {},
            fallback,
        });
        expect(onLimitAlert).toHaveBeenCalledTimes(2);
        expect(onLimitAlert).toHaveBeenLastCalledWith({
            state: 'raised',
            reason: 'instance-limit',
        });

        await unrelated.dispose();
        await first.dispose();
        expect(onLimitAlert).toHaveBeenCalledTimes(2);
        await second.dispose();
        expect(onLimitAlert).toHaveBeenLastCalledWith({ state: 'cleared' });
        await hub.close();
    });

    it('stops retrying a fallback-degraded subscription once disposed', async () => {
        const subscribe = vi.fn(() =>
            Promise.reject(new Error('native backend unavailable')),
        ) as unknown as typeof parcelWatcher.subscribe;
        const hub = new WatchHub({ subscribe });
        const pollOnce = vi.fn(() => Promise.resolve());
        const handle = await hub.register({
            label: 'disposed-before-retry',
            root: '/watched',
            onEvents: () => {},
            fallback: { intervalMs: 100, pollOnce },
        });
        expect(subscribe).toHaveBeenCalledOnce();

        await handle.dispose();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(subscribe).toHaveBeenCalledOnce();
        await hub.close();
    });
});
