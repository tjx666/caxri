import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IdleExitMonitor } from '../idle-exit';
import {
    createIdleExitConnectionTracker,
    createIdleExitMonitor,
    DEFAULT_IDLE_EXIT_MS,
    IDLE_EXIT_ENVIRONMENT_KEY,
    MIN_IDLE_EXIT_MS,
    resolveIdleExitThresholdMs,
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

    it('does not postpone exit when the same zero count is reported repeatedly', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const monitor = createIdleExitMonitor({
            isBusy: () => false,
            onIdleExit,
            thresholdMs: THRESHOLD_MS,
        });

        // The first zero report starts the idle clock.
        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS / 2);
        // A repeated zero report (still no client) must not re-arm a fresh full-threshold timer, or a transport
        // that keeps re-announcing an unchanged zero count could postpone exit indefinitely.
        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS / 2 - 1);
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

    it('drops a check whose idle period ended and restarted while isBusy() was pending', async () => {
        vi.useFakeTimers();
        const onIdleExit = vi.fn();
        const firstCheck = Promise.withResolvers<boolean>();
        const isBusy = vi
            .fn<() => Promise<boolean> | boolean>()
            .mockReturnValueOnce(firstCheck.promise)
            .mockReturnValue(false);
        const monitor = createIdleExitMonitor({ isBusy, onIdleExit, thresholdMs: THRESHOLD_MS });

        monitor.updateConnectionCount(0);
        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
        expect(isBusy).toHaveBeenCalledOnce();

        // A client connects and leaves again while the first health check is still in flight.
        monitor.updateConnectionCount(1);
        monitor.updateConnectionCount(0);
        firstCheck.resolve(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(onIdleExit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
        expect(onIdleExit).toHaveBeenCalledExactlyOnceWith({
            deferralCount: 0,
            idleDurationMs: THRESHOLD_MS,
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

    it('keeps a monitor bound after an early stop() disarmed', () => {
        const tracker = createIdleExitConnectionTracker();
        tracker.stop();
        const { monitor, stop } = createMonitorSpy();

        tracker.bind(monitor);

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

describe('resolveIdleExitThresholdMs', () => {
    function withEnvironment(value: string | undefined): NodeJS.ProcessEnv {
        return value === undefined ? {} : { [IDLE_EXIT_ENVIRONMENT_KEY]: value };
    }

    it('returns undefined when the override is not set', () => {
        expect(resolveIdleExitThresholdMs(withEnvironment(undefined))).toBeUndefined();
    });

    it.each([
        ['the floor itself', String(MIN_IDLE_EXIT_MS), MIN_IDLE_EXIT_MS],
        ['a value above the floor', '60000', 60_000],
        ['the largest safe integer', String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ])('accepts %s', (_description, source, expected) => {
        expect(resolveIdleExitThresholdMs(withEnvironment(source))).toBe(expected);
    });

    it.each([
        ['empty string', ''],
        ['zero', '0'],
        ['a leading zero', '01000'],
        ['a negative number', '-1000'],
        ['a decimal', '1000.5'],
        ['leading whitespace', ' 1000'],
        ['trailing whitespace', '1000 '],
        ['a non-numeric string', 'abc'],
        ['hexadecimal', '0x3e8'],
        ['a plus sign', '+1000'],
    ])('rejects %s', (_description, source) => {
        expect(() => resolveIdleExitThresholdMs(withEnvironment(source))).toThrow(
            `${IDLE_EXIT_ENVIRONMENT_KEY} must be an integer of at least ${MIN_IDLE_EXIT_MS}`,
        );
    });

    it.each([
        ['just below the floor', String(MIN_IDLE_EXIT_MS - 1)],
        ['a single digit above zero', '1'],
    ])('rejects a value below the floor: %s', (_description, source) => {
        expect(() => resolveIdleExitThresholdMs(withEnvironment(source))).toThrow(
            `${IDLE_EXIT_ENVIRONMENT_KEY} must be an integer of at least ${MIN_IDLE_EXIT_MS}`,
        );
    });

    it('rejects a value beyond Number.MAX_SAFE_INTEGER even though it matches the digit format', () => {
        // The regex alone would accept an arbitrarily long digit string; the safe-integer check is what actually
        // bounds it, since `Number()` silently rounds a too-large digit string instead of throwing.
        expect(() =>
            resolveIdleExitThresholdMs(withEnvironment('99999999999999999999999')),
        ).toThrow(
            `${IDLE_EXIT_ENVIRONMENT_KEY} must be an integer of at least ${MIN_IDLE_EXIT_MS}`,
        );
    });
});
