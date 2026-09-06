import { useCallback, useSyncExternalStore } from 'react';

import type { TerminalGpuAcceleration, TerminalRendererStatus } from './terminal-renderer';

export interface TerminalRendererIndicator {
    /**
     * Offered only while the fallback is a preference the chip can actually reverse; absent means the chip stays a
     * read-only reading.
     */
    action?: TerminalRendererIndicatorAction;
    ariaLabel: string;
    label: string;
    title: string;
}

export interface TerminalRendererIndicatorAction {
    confirmLabel: string;
    message: string;
    /**
     * Written to `terminal.gpuAcceleration` once the user confirms.
     */
    preference: TerminalGpuAcceleration;
    title: string;
}

/**
 * Turning GPU acceleration back on is the one renderer fallback the chip can undo by itself, so it is also the only one
 * that earns a click. `unsupported`, `context-loss`, and `load-failed` describe a WebGL context Caxri cannot obtain;
 * writing the same preference again would change nothing, and DESIGN.md's status bar redline forbids a chip that
 * advertises an action it cannot perform.
 */
const ENABLE_GPU_ACCELERATION: TerminalRendererIndicatorAction = {
    confirmLabel: 'Turn On',
    message:
        'Terminals switch from the DOM renderer to WebGL immediately, without restarting Caxri or the Terminal. You can turn it off again in Settings.',
    preference: 'on',
    title: 'Turn on GPU acceleration?',
};

/**
 * The status bar only speaks up while a Terminal is degraded: a WebGL renderer is the healthy default and says nothing,
 * so the chip appears exactly when scrolling and output are running on xterm's slower DOM renderer.
 */
export function terminalRendererIndicator(
    status: TerminalRendererStatus | undefined,
): TerminalRendererIndicator | undefined {
    if (status?.mode !== 'dom' || status.reason === 'disposed') return undefined;
    const detail = terminalRendererDetail(status);
    const action = status.reason === 'disabled' ? ENABLE_GPU_ACCELERATION : undefined;
    // An actionable chip leads with what clicking does, matching the `Open Process Explorer — …` chips beside it, so
    // the accessible name and the tooltip promise exactly the same thing.
    const lead = action ? `${action.title} — ` : '';
    return {
        ...(action && { action }),
        ariaLabel: `${lead}Terminal renderer: DOM. ${detail}`,
        label: 'DOM',
        title: `${lead}Terminal is using the DOM renderer. ${detail}`,
    };
}

function terminalRendererDetail(status: TerminalRendererStatus): string {
    if (status.reason === 'disabled') return 'GPU acceleration is turned off in Settings.';
    if (status.reason === 'unsupported') return 'WebGL2 is unavailable in this window.';
    if (status.reason === 'context-loss-limit')
        return 'WebGL was lost repeatedly (GPU process exits or context losses); it stays off until GPU acceleration is changed in Settings or Caxri restarts.';
    const cause =
        status.reason === 'context-loss' ? 'The WebGL context was lost.' : 'WebGL failed to load.';
    if (status.retryState === 'exhausted')
        return `${cause} Retries exhausted; reopen the Terminal tab or restart Caxri to try again.`;
    if (['deferred', 'failed', 'scheduled', 'trying'].includes(status.retryState))
        return `${cause} Retrying WebGL (${status.retryAttemptCount}/${status.retryLimit}).`;
    return cause;
}

/**
 * Ephemeral per-Terminal renderer state for UI surfaces outside the pane. Publishing is synchronous because renderer
 * transitions are rare (preference changes, context loss, retries), unlike OSC progress updates.
 */
export class TerminalRendererStatusRegistry {
    private readonly current = new Map<string, TerminalRendererStatus>();
    private readonly listeners = new Map<string, Set<() => void>>();

    private notify(terminalId: string): void {
        const listeners = this.listeners.get(terminalId) ?? [];
        for (const listener of listeners) listener();
    }

    get(terminalId: string): TerminalRendererStatus | undefined {
        return this.current.get(terminalId);
    }

    subscribe(terminalId: string, listener: () => void): () => void {
        const listeners = this.listeners.get(terminalId) ?? new Set<() => void>();
        listeners.add(listener);
        this.listeners.set(terminalId, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.listeners.delete(terminalId);
        };
    }

    publish(terminalId: string, status: TerminalRendererStatus): void {
        if (status.reason === 'disposed') {
            this.clear(terminalId);
            return;
        }
        this.current.set(terminalId, status);
        this.notify(terminalId);
    }

    clear(terminalId: string): void {
        if (this.current.delete(terminalId)) this.notify(terminalId);
    }
}

const terminalRendererStatusRegistry = new TerminalRendererStatusRegistry();

export function publishTerminalRendererStatus(
    terminalId: string,
    status: TerminalRendererStatus,
): void {
    terminalRendererStatusRegistry.publish(terminalId, status);
}

export function clearTerminalRendererStatus(terminalId: string): void {
    terminalRendererStatusRegistry.clear(terminalId);
}

export function useTerminalRendererStatus(terminalId: string): TerminalRendererStatus | undefined {
    const subscribe = useCallback(
        (listener: () => void) => terminalRendererStatusRegistry.subscribe(terminalId, listener),
        [terminalId],
    );
    const getSnapshot = useCallback(
        () => terminalRendererStatusRegistry.get(terminalId),
        [terminalId],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
