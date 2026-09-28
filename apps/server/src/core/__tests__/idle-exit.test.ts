import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdleExitMonitor } from '../idle-exit';
import {
    createIdleExitConnectionTracker,
    createIdleExitMonitor,
    DEFAULT_IDLE_EXIT_MS,
} from '../idle-exit';

const THRESHOLD_MS = 1_000;

function createMonitorSpy(): {
    monitor: IdleExitMonitor;
    stop: ReturnType<typeof vi.fn>;
    updateConnectionCount: ReturnType<typeof vi.fn>;
} {
    const updateConnectionCount = vi.fn();
    const stop = vi.fn();
    return { monitor: { stop, updateConnectionCount }, stop, updateConnectionCount };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('createIdleExitMonitor', () => {
    it('exits once the connection count has been zero for the full threshold', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const monitor = createIdleExitMonitor({
            isBusy: () => false,
            onIdleExit,
            thresholdMs: THRESHOLD_MS,
        });

        monitor.updateConnectionCount(0);
        expect(onIdleExit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);

        expect(onIdleExit).toHaveBeenCalledExactlyOnceWith({
            deferralCount: 0,
            idleDurationMs: THRESHOLD_MS,
        });
    });

    it('resets the idle clock and cancels the pending check on reconnect within the threshold', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const monitor = createIdleExitMonitor({
            isBusy: () => false,
            onIdleExit,
            thresholdMs: THRESHOLD_MS,
        });

        // A Desktop lease revocation drops the count to zero, arming the check.
        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS / 2);
        // The Desktop reconnects before the threshold elapses.
        monitor.updateConnectionCount(1);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
        expect(onIdleExit).not.toHaveBeenCalled();

        // A later drop to zero starts a fresh full window rather than continuing the earlier one.
        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS - 1);
        expect(onIdleExit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onIdleExit).toHaveBeenCalledExactlyOnceWith({
            deferralCount: 0,
            idleDurationMs: THRESHOLD_MS,
        });
    });

    it('never arms while at least one client (Desktop, Mobile, Agent, or CLI) is connected', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const monitor = createIdleExitMonitor({
            isBusy: () => false,
            onIdleExit,
            thresholdMs: THRESHOLD_MS,
        });

        // e.g. a Mobile device stays paired and connected even though Desktop never attached.
        monitor.updateConnectionCount(1);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS * 5);

        expect(onIdleExit).not.toHaveBeenCalled();
    });

    it('defers and rechecks after the threshold while a PTY is busy, then exits once it frees up', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        let isBusy = true;
        const write = vi.fn();
        const monitor = createIdleExitMonitor({
            isBusy: () => isBusy,
            logger: { write },
            onIdleExit,
            thresholdMs: THRESHOLD_MS,
        });

        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
        expect(onIdleExit).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledExactlyOnceWith(
            'info',
            'server_core.idle_exit_deferred',
            expect.objectContaining({
                fields: { deferralCount: 1, idleDurationMs: THRESHOLD_MS, reason: 'active-pty' },
            }),
        );

        // Still busy on the second sweep: the deferral count accumulates instead of resetting.
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
        expect(onIdleExit).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenLastCalledWith(
            'info',
            'server_core.idle_exit_deferred',
            expect.objectContaining({
                fields: {
                    deferralCount: 2,
                    idleDurationMs: THRESHOLD_MS * 2,
                    reason: 'active-pty',
                },
            }),
        );

        isBusy = false;
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
        expect(onIdleExit).toHaveBeenCalledExactlyOnceWith({
            deferralCount: 2,
            idleDurationMs: THRESHOLD_MS * 3,
        });
    });

    it('treats a rejected isBusy() check as busy rather than exiting on an unexpected error', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const monitor = createIdleExitMonitor({
            isBusy: () => Promise.reject(new Error('health check unavailable')),
            onIdleExit,
            thresholdMs: THRESHOLD_MS,
        });

        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);

        expect(onIdleExit).not.toHaveBeenCalled();
    });

    it('stop() disarms any pending check and ignores later connection-count updates', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const monitor = createIdleExitMonitor({
            isBusy: () => false,
            onIdleExit,
            thresholdMs: THRESHOLD_MS,
        });

        monitor.updateConnectionCount(0);
        monitor.stop();
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS * 5);
        expect(onIdleExit).not.toHaveBeenCalled();

        // A late update after stop() must not resurrect the timer.
        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS * 5);
        expect(onIdleExit).not.toHaveBeenCalled();
    });

    it('defaults the threshold to DEFAULT_IDLE_EXIT_MS when none is configured', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const monitor = createIdleExitMonitor({ isBusy: () => false, onIdleExit });

        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_EXIT_MS - 1);
        expect(onIdleExit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onIdleExit).toHaveBeenCalledExactlyOnceWith({
            deferralCount: 0,
            idleDurationMs: DEFAULT_IDLE_EXIT_MS,
        });
    });
});

describe('createIdleExitConnectionTracker', () => {
    it('reports the current aggregate immediately on bind, even when it observed updates first', () => {
        const tracker = createIdleExitConnectionTracker();
        tracker.updateControlCount(1);
        const { monitor, updateConnectionCount } = createMonitorSpy();

        tracker.bind(monitor);

        expect(updateConnectionCount).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('sums the control and Mobile counts into one aggregate on every update', () => {
        const tracker = createIdleExitConnectionTracker();
        const { monitor, updateConnectionCount } = createMonitorSpy();
        tracker.bind(monitor);
        updateConnectionCount.mockClear();

        tracker.updateControlCount(2);
        expect(updateConnectionCount).toHaveBeenLastCalledWith(2);
        tracker.updateMobileCount(3);
        expect(updateConnectionCount).toHaveBeenLastCalledWith(5);
        tracker.updateControlCount(0);
        expect(updateConnectionCount).toHaveBeenLastCalledWith(3);
    });

    it('forwards stop() to the bound monitor', () => {
        const tracker = createIdleExitConnectionTracker();
        const { monitor, stop } = createMonitorSpy();
        tracker.bind(monitor);

        tracker.stop();

        expect(stop).toHaveBeenCalledOnce();
    });

    it('ignores stop() and connection updates before a monitor is bound', () => {
        const tracker = createIdleExitConnectionTracker();

        expect(() => {
            tracker.stop();
            tracker.updateControlCount(1);
            tracker.updateMobileCount(2);
        }).not.toThrow();
    });
});
