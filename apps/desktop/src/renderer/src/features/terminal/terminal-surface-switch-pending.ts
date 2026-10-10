import { useSyncExternalStore } from 'react';

import type { TerminalSurface } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';

/**
 * Tracks which Terminals have a surface switch in flight and which surface each is heading to. The Server awaits a full
 * provider restart before it answers `terminal.switchSurface`, which takes several seconds, so the rail toggle needs a
 * pending state and every entry point (toggle, tab menu, `Cmd+Shift+J`, native menu) needs one shared re-entry guard: a
 * second request for the same Terminal would race the first restart.
 */
export class TerminalSurfaceSwitchRegistry {
    private readonly pending = new Map<string, TerminalSurface>();
    private readonly listeners = new Set<() => void>();

    private notify(): void {
        notifyListeners(this.listeners, undefined);
    }

    private async settle(terminalId: string, task: () => Promise<void>): Promise<void> {
        try {
            await task();
        } finally {
            this.pending.delete(terminalId);
            this.notify();
        }
    }

    /**
     * Runs `task` as the only switch for `terminalId`, or returns `undefined` without running it while another switch
     * for that Terminal is still pending. The pending mark clears when the task settles, success or failure.
     */
    run(
        terminalId: string,
        surface: TerminalSurface,
        task: () => Promise<void>,
    ): Promise<void> | undefined {
        if (this.pending.has(terminalId)) return undefined;
        this.pending.set(terminalId, surface);
        this.notify();
        return this.settle(terminalId, task);
    }

    pendingSurface(terminalId: string): TerminalSurface | undefined {
        return this.pending.get(terminalId);
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export const terminalSurfaceSwitches = new TerminalSurfaceSwitchRegistry();

function subscribeToSurfaceSwitches(listener: () => void): () => void {
    return terminalSurfaceSwitches.subscribe(listener);
}

/**
 * The surface a pending switch for `terminalId` is opening, or `undefined` when none is in flight.
 */
export function usePendingTerminalSurface(terminalId: string): TerminalSurface | undefined {
    return useSyncExternalStore(subscribeToSurfaceSwitches, () =>
        terminalSurfaceSwitches.pendingSurface(terminalId),
    );
}
