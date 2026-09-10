import { useCallback, useSyncExternalStore } from 'react';

import type { TerminalGpuAcceleration, TerminalRendererStatus } from './terminal-renderer';

export interface TerminalRendererIndicator {
    /**
     * Absent while automatic recovery is in progress; settled fallbacks offer an explicit retry.
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
     * Written to `terminal.gpuAcceleration` once confirmed. Absent means retry the mounted renderer instead.
     */
    preference?: TerminalGpuAcceleration;
    title: string;
}

/**
 * Preference-driven fallback uses the settings write; failures instead retry the mounted renderer directly.
 */
const ENABLE_GPU_ACCELERATION: TerminalRendererIndicatorAction = {
    confirmLabel: 'Turn On',
    message:
        'Terminals switch from the DOM renderer to WebGL immediately, without restarting Caxri or the Terminal. You can turn it off again in Settings.',
    preference: 'on',
    title: 'Turn on GPU acceleration?',
};

const RETRY_GPU_ACCELERATION: TerminalRendererIndicatorAction = {
    confirmLabel: 'Retry GPU',
    message:
        'Retry GPU rendering for this Terminal and reset the GPU failure limit for this window. Your Terminal and Agent keep running, and settings stay unchanged. If the attempt fails, the Terminal keeps using DOM rendering.',
    title: 'Retry GPU rendering?',
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
    const isRetrying = ['deferred', 'failed', 'scheduled', 'trying'].includes(status.retryState);
    const action =
        status.reason === 'disabled'
            ? ENABLE_GPU_ACCELERATION
            : !isRetrying || status.reason === 'context-loss-limit'
              ? RETRY_GPU_ACCELERATION
              : undefined;
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
        return 'WebGL was lost repeatedly. Automatic recovery is paused; click to retry GPU rendering.';
    const cause =
        status.reason === 'context-loss' ? 'The WebGL context was lost.' : 'WebGL failed to load.';
    if (status.retryState === 'exhausted')
        return `${cause} Retries exhausted; click to retry GPU rendering.`;
    if (['deferred', 'failed', 'scheduled', 'trying'].includes(status.retryState))
        return `${cause} Retrying WebGL (${status.retryAttemptCount}/${status.retryLimit}).`;
    return cause;
}

type TerminalRendererRetry = () => boolean;

/**
 * Ephemeral per-Terminal renderer state for UI surfaces outside the pane. Publishing is synchronous because renderer
 * transitions are rare (preference changes, context loss, retries), unlike OSC progress updates.
 */
export class TerminalRendererStatusRegistry {
    private readonly retryHandlers = new Map<string, () => boolean>();
    private readonly current = new Map<string, TerminalRendererStatus>();
    private readonly listeners = new Map<string, Set<() => void>>();

    private notify(terminalId: string): void {
        const listeners = this.listeners.get(terminalId) ?? [];
        for (const listener of listeners) listener();
    }

    // eslint-disable-next-line unicorn/consistent-boolean-name -- retry performs recovery and returns its outcome; it is not a predicate
    registerRetry(terminalId: string, retry: TerminalRendererRetry): () => void {
        this.retryHandlers.set(terminalId, retry);
        return () => {
            if (this.retryHandlers.get(terminalId) === retry) this.retryHandlers.delete(terminalId);
        };
    }

    getRetry(terminalId: string): (() => boolean) | undefined {
        return this.retryHandlers.get(terminalId);
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

export function registerTerminalRendererRetry(
    terminalId: string,
    // eslint-disable-next-line unicorn/consistent-boolean-name -- retry performs recovery and returns its outcome; it is not a predicate
    retry: TerminalRendererRetry,
): () => void {
    return terminalRendererStatusRegistry.registerRetry(terminalId, retry);
}

export function getTerminalRendererRetry(terminalId: string): (() => boolean) | undefined {
    return terminalRendererStatusRegistry.getRetry(terminalId);
}

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
