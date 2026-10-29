import { describe, expect, it, vi } from 'vitest';

import {
    DIRECT_PROBE_INTERVAL_MS,
    DIRECT_PROBE_MINIMUM_RELAY_AGE_MS,
    DirectRouteProbe,
} from '../direct-route-probe';

/**
 * A probe driven by hand: each tick runs the next scripted answer, and time moves only when the test says so.
 */
const harness = (input: {
    answers: Array<boolean | Promise<boolean>>;
    canUpgrade?: () => boolean;
}) => {
    const clock = { now: 0 };
    const ticks: Array<() => void> = [];
    const onUpgrade = vi.fn();
    const probe = vi.fn(() => Promise.resolve(input.answers.shift() ?? false));
    const directRoute = new DirectRouteProbe({
        probe,
        onUpgrade,
        canUpgrade: input.canUpgrade,
        now: () => clock.now,
        readyAt: 0,
        setInterval: (callback, ms) => {
            expect(ms).toBe(DIRECT_PROBE_INTERVAL_MS);
            ticks.push(callback);
            return ticks.length as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: (handle) => {
            ticks[(handle as unknown as number) - 1] = () => {};
        },
    });
    const tick = async (): Promise<void> => {
        clock.now += DIRECT_PROBE_INTERVAL_MS;
        ticks.at(-1)?.();
        await Promise.resolve();
        await Promise.resolve();
    };
    return { clock, directRoute, onUpgrade, probe, tick, ticks };
};

describe('direct route probe', () => {
    it('upgrades after three consecutive answers once the Relay session is a minute old', async () => {
        const { directRoute, onUpgrade, tick } = harness({ answers: [true, true, true] });
        directRoute.start();

        await tick();
        await tick();
        expect(onUpgrade).not.toHaveBeenCalled();
        await tick();

        expect(onUpgrade).toHaveBeenCalledOnce();
        expect(directRoute.isRunning).toBe(false);
    });

    it('restarts the streak after a failed probe', async () => {
        const { directRoute, onUpgrade, tick } = harness({
            answers: [true, true, false, true, true, true],
        });
        directRoute.start();

        await tick();
        await tick();
        await tick();
        await tick();
        await tick();
        expect(onUpgrade).not.toHaveBeenCalled();
        await tick();
        expect(onUpgrade).toHaveBeenCalledOnce();
    });

    it('counts a throwing probe as a failure', async () => {
        const { directRoute, onUpgrade, probe, tick } = harness({ answers: [] });
        probe.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(true);
        directRoute.start();

        await tick();
        await tick();
        await tick();
        expect(onUpgrade).not.toHaveBeenCalled();
        await tick();
        expect(onUpgrade).toHaveBeenCalledOnce();
    });

    it('waits until the Relay session is old enough', async () => {
        const { clock, directRoute, onUpgrade, tick } = harness({
            answers: [true, true, true, true],
        });
        clock.now = -DIRECT_PROBE_MINIMUM_RELAY_AGE_MS;
        directRoute.start();

        await tick();
        await tick();
        await tick();
        expect(clock.now).toBeLessThan(DIRECT_PROBE_MINIMUM_RELAY_AGE_MS);
        expect(onUpgrade).not.toHaveBeenCalled();
        await tick();
        expect(onUpgrade).toHaveBeenCalledOnce();
    });

    it('keeps the streak while an upgrade is refused', async () => {
        let isSafe = false;
        const { directRoute, onUpgrade, tick } = harness({
            answers: [true, true, true, true],
            canUpgrade: () => isSafe,
        });
        directRoute.start();

        await tick();
        await tick();
        await tick();
        expect(onUpgrade).not.toHaveBeenCalled();
        isSafe = true;
        await tick();
        expect(onUpgrade).toHaveBeenCalledOnce();
    });

    it('drops an in-flight answer after stop and starts a fresh streak on restart', async () => {
        const pending: { resolve?: (isReachable: boolean) => void } = {};
        const { directRoute, onUpgrade, probe, tick } = harness({ answers: [] });
        probe
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockImplementationOnce(
                () =>
                    new Promise<boolean>((resolve) => {
                        pending.resolve = resolve;
                    }),
            )
            .mockResolvedValue(true);
        directRoute.start();
        await tick();
        await tick();
        await tick();

        directRoute.stop();
        pending.resolve?.(true);
        await Promise.resolve();
        expect(onUpgrade).not.toHaveBeenCalled();

        directRoute.start();
        await tick();
        await tick();
        expect(onUpgrade).not.toHaveBeenCalled();
        await tick();
        expect(onUpgrade).toHaveBeenCalledOnce();
    });

    it('starts only one interval however often the app returns to the foreground', () => {
        const { directRoute, ticks } = harness({ answers: [] });
        directRoute.start();
        directRoute.start();

        expect(ticks).toHaveLength(1);
        expect(directRoute.isRunning).toBe(true);
    });
});
