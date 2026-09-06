interface VisibilityRestoreSchedulerOptions {
    cancelFrame?: (handle: number) => void;
    requestFrame?: (callback: () => void) => number;
}

export interface VisibilityRestoreScheduler {
    /**
     * Drops a pending restore for an unmounted Terminal; a scheduled frame with nothing left to run is released.
     */
    cancel(key: string): void;
    /**
     * Renderer-lifetime count of events merged into an already pending restore for the same Terminal.
     */
    coalescedCount(): number;
    schedule(key: string, restore: () => void): void;
}

/**
 * Merges the window `focus`, document `visibilitychange`, and `pageshow` events that macOS fires together on window or
 * Space restore into one renderer restore per Terminal per frame, and spreads different Terminals over consecutive
 * frames in mount order. Without it every mounted pane cleared its WebGL glyph atlas and redrew twice in the same
 * frame, the burst #558 suspected of preceding GPU process exits. `useOnVisible` stays generic; only Terminal restores
 * are frame-scheduled.
 */
export function createVisibilityRestoreScheduler(
    options: VisibilityRestoreSchedulerOptions = {},
): VisibilityRestoreScheduler {
    const requestFrame =
        options.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
    const pending = new Map<string, () => void>();
    let coalesced = 0;
    let frame: number | undefined;

    function flush(): void {
        frame = undefined;
        const next = pending.entries().next();
        if (next.done) return;
        const [key, restore] = next.value;
        pending.delete(key);
        // One Terminal per frame; the rest wait for the following frames in the order they were scheduled.
        if (pending.size > 0) frame = requestFrame(flush);
        restore();
    }

    return {
        cancel(key: string): void {
            pending.delete(key);
            if (frame !== undefined && pending.size === 0) {
                cancelFrame(frame);
                frame = undefined;
            }
        },
        coalescedCount(): number {
            return coalesced;
        },
        schedule(key: string, restore: () => void): void {
            if (pending.has(key)) coalesced += 1;
            // `Map.set` on an existing key keeps its original position, so a repeated event never reorders panes.
            pending.set(key, restore);
            frame ??= requestFrame(flush);
        },
    };
}

export const terminalVisibilityRestoreScheduler = createVisibilityRestoreScheduler();
