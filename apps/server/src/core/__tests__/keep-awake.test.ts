import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeepAwakeChild, KeepAwakeDemand } from '../keep-awake';
import {
    createKeepAwakeController,
    KEEP_AWAKE_COALESCE_MS,
    KEEP_AWAKE_RETRY_MS,
} from '../keep-awake';

class FakeChild implements KeepAwakeChild {
    private readonly listeners = new Map<string, (value: never) => void>();
    killed = false;

    kill(): boolean {
        this.killed = true;
        return true;
    }

    once(event: string, listener: (value: never) => void): this {
        this.listeners.set(event, listener);
        return this;
    }

    exit(code: number | null): void {
        (this.listeners.get('exit') as ((value: number | null) => void) | undefined)?.(code);
    }
}

function setup(initial: Partial<KeepAwakeDemand> = {}, platform: NodeJS.Platform = 'darwin') {
    let demand: KeepAwakeDemand = { isEnabled: true, working: 0, usageWaiting: 0, ...initial };
    const spawned: FakeChild[] = [];
    const spawn = vi.fn<(command: string, arguments_: readonly string[]) => KeepAwakeChild>(() => {
        const child = new FakeChild();
        spawned.push(child);
        return child;
    });
    const write = vi.fn();
    const controller = createKeepAwakeController({
        logger: { write },
        readDemand: () => Promise.resolve(demand),
        platform,
        pid: 4242,
        spawn,
    });
    return {
        spawned,
        controller,
        set: (next: Partial<KeepAwakeDemand>) => {
            demand = { ...demand, ...next };
            controller.schedule();
        },
        settle: () => vi.advanceTimersByTimeAsync(KEEP_AWAKE_COALESCE_MS),
        spawn,
        write,
    };
}

function lastFields(write: ReturnType<typeof vi.fn>): unknown {
    return (write.mock.calls.at(-1)?.[2] as { fields?: unknown } | undefined)?.fields;
}

describe('createKeepAwakeController', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('holds the Mac awake tied to Server Core while Agents work, and releases when they finish', async () => {
        const harness = setup();
        harness.set({ working: 2 });
        await harness.settle();
        expect(harness.spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-w', '4242']);
        expect(harness.controller.status().active).toBe(true);

        harness.set({ working: 0 });
        await harness.settle();
        expect(harness.spawned[0]?.killed).toBe(true);
        expect(harness.controller.status()).toEqual({ active: false });
        expect(lastFields(harness.write)).toEqual({ reason: 'work-finished', peakWorking: 2 });
    });

    it('coalesces a burst of changes into one hold', async () => {
        const harness = setup();
        for (let index = 0; index < 10; index += 1) harness.set({ working: index + 1 });
        await harness.settle();
        expect(harness.spawn).toHaveBeenCalledTimes(1);
    });

    it('holds for a Chat waiting on its usage limit', async () => {
        const harness = setup({ usageWaiting: 1 });
        harness.controller.schedule();
        await harness.settle();
        expect(harness.controller.status().active).toBe(true);
    });

    it('releases with reason disabled when the setting turns off', async () => {
        const harness = setup({ working: 1 });
        harness.controller.schedule();
        await harness.settle();
        harness.set({ isEnabled: false });
        await harness.settle();
        expect(harness.controller.status().active).toBe(false);
        expect(lastFields(harness.write)).toEqual({ reason: 'disabled', peakWorking: 1 });
    });

    it('backs off after the assertion exits unexpectedly, then holds again', async () => {
        const harness = setup({ working: 1 });
        harness.controller.schedule();
        await harness.settle();
        harness.spawned[0]?.exit(1);
        await harness.settle();
        expect(harness.spawn).toHaveBeenCalledTimes(1);
        expect(harness.controller.status().active).toBe(false);
        expect(lastFields(harness.write)).toEqual({
            errorCode: 'exit-1',
            consecutiveFailures: 1,
            retryInMs: KEEP_AWAKE_RETRY_MS,
        });

        await vi.advanceTimersByTimeAsync(KEEP_AWAKE_RETRY_MS);
        harness.controller.schedule();
        await harness.settle();
        expect(harness.spawn).toHaveBeenCalledTimes(2);
    });

    it('releases on stop and ignores later schedules', async () => {
        const harness = setup({ working: 1 });
        harness.controller.schedule();
        await harness.settle();
        harness.controller.stop();
        expect(harness.spawned[0]?.killed).toBe(true);
        harness.controller.schedule();
        await harness.settle();
        expect(harness.spawn).toHaveBeenCalledTimes(1);
    });

    it('does nothing off macOS', async () => {
        const harness = setup({ working: 1 }, 'linux');
        harness.controller.schedule();
        await harness.settle();
        expect(harness.spawn).not.toHaveBeenCalled();
    });
});
