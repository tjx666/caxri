import { useCallback, useSyncExternalStore } from 'react';

import { notifyListeners } from '@caxri/utils';

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

/**
 * Two of the chip's three answers change something and ask first; the third only navigates, so it must not be routed
 * through a confirmation that has nothing to confirm.
 */
type TerminalRendererIndicatorAction =
    TerminalRendererConfirmAction | TerminalRendererSettingsAction;

export interface TerminalRendererConfirmAction {
    confirmLabel: string;
    message: string;
    /**
     * Written to `terminal.gpuAcceleration` once confirmed. Absent means retry the mounted renderer instead.
     */
    preference?: TerminalGpuAcceleration;
    title: string;
}

export interface TerminalRendererIndicatorOptions {
    /**
     * Whether `argv.jsonc` turned hardware acceleration off for every launch. Read rather than inferred: the renderer
     * probe cannot tell a missing GPU apart from one the app declined at boot.
     */
    isHardwareAccelerationOff?: boolean;
}

interface TerminalRendererSettingsAction {
    /**
     * Discriminates the navigating answer from the two confirming ones.
     */
    opensSettings: true;
    title: string;
}

/**
 * Preference-driven fallback uses the settings write; failures instead retry the mounted renderer directly.
 */
const ENABLE_GPU_ACCELERATION: TerminalRendererConfirmAction = {
    confirmLabel: 'Turn On',
    message:
        'Terminals start drawing with the GPU immediately, without restarting Caxri or the Terminal. You can turn it off again in Settings.',
    preference: 'on',
    title: 'Turn on GPU acceleration for Terminals?',
};

const RETRY_GPU_ACCELERATION: TerminalRendererConfirmAction = {
    confirmLabel: 'Retry GPU',
    message:
        'Retry GPU rendering for this Terminal and reset the graphics failure limit for this window. Your Terminal and Agent keep running, and settings stay unchanged. If the attempt fails, the Terminal keeps using software rendering.',
    title: 'Retry GPU rendering?',
};

/**
 * `unsupported` normally means a live `getContext('webgl2')` probe failed, which a later re-probe can pass — so the
 * retry stays. It cannot pass in a window launched with hardware acceleration off: the probe would run against a GPU
 * the app declined at boot, and offering it would relabel a settled no as something still worth clicking (DESIGN.md
 * principle 9). Only then is Settings the honest answer, and it is also the only route back from that state.
 */
const OPEN_HARDWARE_ACCELERATION_SETTINGS: TerminalRendererSettingsAction = {
    opensSettings: true,
    title: 'Open Settings',
};

/**
 * The status bar only speaks up while a Terminal is degraded: a WebGL renderer is the healthy default and says nothing,
 * so the chip appears exactly when scrolling and output are running on xterm's slower DOM renderer.
 */
export function terminalRendererIndicator(
    status: TerminalRendererStatus | undefined,
    options: TerminalRendererIndicatorOptions = {},
): TerminalRendererIndicator | undefined {
    if (status?.mode !== 'dom' || status.reason === 'disposed') return undefined;
    const isBootDisabled = status.reason === 'unsupported' && options.isHardwareAccelerationOff;
    const detail = terminalRendererDetail(status, Boolean(isBootDisabled));
    const isRetrying = ['deferred', 'failed', 'scheduled', 'trying'].includes(status.retryState);
    const action: TerminalRendererIndicatorAction | undefined = isBootDisabled
        ? OPEN_HARDWARE_ACCELERATION_SETTINGS
        : status.reason === 'disabled'
          ? ENABLE_GPU_ACCELERATION
          : !isRetrying || status.reason === 'context-loss-limit'
            ? RETRY_GPU_ACCELERATION
            : undefined;
    // An actionable chip leads with what clicking does, matching the `Open Process Explorer — …` chips beside it, so
    // the accessible name and the tooltip promise exactly the same thing. A confirming action's title is already a
    // question, so it reads as the promise directly.
    const lead = action ? `${action.title} — ` : '';
    return {
        ...(action && { action }),
        ariaLabel: `${lead}Terminal is using software rendering. ${detail}`,
        label: 'Software',
        title: `${lead}Terminal is using software rendering. ${detail}`,
    };
}

function terminalRendererDetail(status: TerminalRendererStatus, isBootDisabled: boolean): string {
    if (status.reason === 'disabled') return 'GPU acceleration is turned off in Settings.';
    if (isBootDisabled)
        return 'Hardware acceleration is turned off, so no Terminal in any window can use the GPU.';
    if (status.reason === 'unsupported') return 'The GPU is unavailable in this window right now.';
    if (status.reason === 'context-loss-limit')
        return 'Drawing failed repeatedly. Automatic recovery is paused; click to retry GPU rendering.';
    const cause =
        status.reason === 'context-loss'
            ? 'GPU drawing was interrupted.'
            : 'GPU drawing failed to start.';
    if (status.retryState === 'exhausted')
        return `${cause} Retries exhausted; click to retry GPU rendering.`;
    if (['deferred', 'failed', 'scheduled', 'trying'].includes(status.retryState))
        return `${cause} Trying the GPU again (${status.retryAttemptCount}/${status.retryLimit}).`;
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
        // Isolates each Terminal renderer-status subscriber so one throwing panel cannot stop this Terminal's other
        // panels from observing the transition; Desktop mirrors `console.error` into `logs/desktop.jsonl`.
        notifyListeners(listeners, undefined, (error) =>
            console.error('terminal.rendererStatus listener failed', error),
        );
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
