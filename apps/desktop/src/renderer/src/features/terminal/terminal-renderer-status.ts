import { useCallback, useSyncExternalStore } from 'react';

import type { TerminalRendererStatus } from './terminal-renderer';

export interface TerminalRendererIndicator {
    ariaLabel: string;
    label: string;
    title: string;
}

/**
 * The status bar only speaks up while a Terminal is degraded: a WebGL renderer is the healthy default and says nothing,
 * so the chip appears exactly when scrolling and output are running on xterm's slower DOM renderer.
 */
export function terminalRendererIndicator(
    status: TerminalRendererStatus | undefined,
): TerminalRendererIndicator | undefined {
    if (status?.mode !== 'dom' || status.reason === 'disposed') return undefined;
    const detail = terminalRendererDetail(status);
    return {
        ariaLabel: `Terminal renderer: DOM. ${detail}`,
        label: 'DOM',
        title: `Terminal is using the DOM renderer. ${detail}`,
    };
}

function terminalRendererDetail(status: TerminalRendererStatus): string {
    if (status.reason === 'disabled') return 'GPU acceleration is turned off in Settings.';
    if (status.reason === 'unsupported') return 'WebGL2 is unavailable in this window.';
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
