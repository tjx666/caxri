import { describe, expect, it, vi } from 'vitest';

import { createVisibilityRestoreScheduler } from '../terminal-visibility-restore';

function createHarness() {
    const frames: Array<(() => void) | undefined> = [];
    const scheduler = createVisibilityRestoreScheduler({
        cancelFrame: (handle) => {
            frames[handle] = undefined;
        },
        requestFrame: (callback) => frames.push(callback) - 1,
    });
    return {
        frames,
        runFrame(index: number): void {
            const callback = frames[index];
            frames[index] = undefined;
            callback?.();
        },
        scheduler,
    };
}

describe('terminal visibility restore scheduler', () => {
    it('merges focus, visibilitychange, and pageshow for one pane into a single restore', () => {
        const harness = createHarness();
        const restore = vi.fn();

        harness.scheduler.schedule('terminal-1', restore);
        harness.scheduler.schedule('terminal-1', restore);
        harness.scheduler.schedule('terminal-1', restore);

        expect(restore).not.toHaveBeenCalled();
        expect(harness.frames).toHaveLength(1);
        harness.runFrame(0);
        expect(restore).toHaveBeenCalledOnce();
        expect(harness.scheduler.coalescedCount()).toBe(2);
    });

    it('staggers different panes over consecutive frames in scheduling order', () => {
        const harness = createHarness();
        const order: string[] = [];
        for (const terminalId of ['terminal-1', 'terminal-2', 'terminal-3'])
            harness.scheduler.schedule(terminalId, () => order.push(terminalId));
        // A repeated event for the first pane keeps its position instead of moving it behind the others.
        harness.scheduler.schedule('terminal-1', () => order.push('terminal-1'));

        harness.runFrame(0);
        expect(order).toEqual(['terminal-1']);
        expect(harness.frames).toHaveLength(2);
        harness.runFrame(1);
        expect(order).toEqual(['terminal-1', 'terminal-2']);
        harness.runFrame(2);
        expect(order).toEqual(['terminal-1', 'terminal-2', 'terminal-3']);
        expect(harness.frames).toHaveLength(3);
        expect(harness.scheduler.coalescedCount()).toBe(1);
    });

    it('drops an unmounted pane and releases the frame when nothing is left', () => {
        const harness = createHarness();
        const first = vi.fn();
        const second = vi.fn();
        harness.scheduler.schedule('terminal-1', first);
        harness.scheduler.schedule('terminal-2', second);

        harness.scheduler.cancel('terminal-1');
        harness.runFrame(0);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();

        harness.scheduler.schedule('terminal-3', first);
        harness.scheduler.cancel('terminal-3');
        expect(harness.frames[1]).toBeUndefined();
        harness.scheduler.schedule('terminal-3', first);
        harness.runFrame(2);
        expect(first).toHaveBeenCalledOnce();
    });

    it('keeps the remaining panes scheduled when one restore throws', () => {
        const harness = createHarness();
        const second = vi.fn();
        harness.scheduler.schedule('terminal-1', () => {
            throw new Error('atlas');
        });
        harness.scheduler.schedule('terminal-2', second);

        expect(() => harness.runFrame(0)).toThrow('atlas');
        harness.runFrame(1);
        expect(second).toHaveBeenCalledOnce();
    });
});
