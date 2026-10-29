import { useCallback, useSyncExternalStore } from 'react';

import { notifyListeners } from '@caxri/utils';

import type { Translate } from '../../i18n';
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
function enableGpuAcceleration(t: Translate): TerminalRendererConfirmAction {
    return {
        confirmLabel: t('terminal.renderer.enable.confirmLabel'),
        message: t('terminal.renderer.enable.message'),
        preference: 'on',
        title: t('terminal.renderer.enable.title'),
    };
}

function retryGpuAcceleration(t: Translate): TerminalRendererConfirmAction {
    return {
        confirmLabel: t('terminal.renderer.retry.confirmLabel'),
        message: t('terminal.renderer.retry.message'),
        title: t('terminal.renderer.retry.title'),
    };
}

/**
 * `unsupported` normally means a live `getContext('webgl2')` probe failed, which a later re-probe can pass, so the
 * retry stays. It cannot pass in a window launched with hardware acceleration off: the probe would run against a GPU
 * the app declined at boot, and offering it would relabel a settled no as something still worth clicking (DESIGN.md
 * principle 9). Only then is Settings the honest answer, and it is also the only route back from that state.
 */
function openHardwareAccelerationSettings(t: Translate): TerminalRendererSettingsAction {
    return { opensSettings: true, title: t('terminal.recovery.openSettings') };
}

/**
 * The status bar only speaks up while a Terminal is degraded: a WebGL renderer is the healthy default and says nothing,
 * so the chip appears exactly when scrolling and output are running on xterm's slower DOM renderer.
 */
export function terminalRendererIndicator(
    status: TerminalRendererStatus | undefined,
    options: TerminalRendererIndicatorOptions,
    t: Translate,
): TerminalRendererIndicator | undefined {
    if (status?.mode !== 'dom' || status.reason === 'disposed') return undefined;
    const isBootDisabled = status.reason === 'unsupported' && options.isHardwareAccelerationOff;
    const detail = terminalRendererDetail(status, Boolean(isBootDisabled), t);
    const isRetrying = ['deferred', 'failed', 'scheduled', 'trying'].includes(status.retryState);
    const action: TerminalRendererIndicatorAction | undefined = isBootDisabled
        ? openHardwareAccelerationSettings(t)
        : status.reason === 'disabled'
          ? enableGpuAcceleration(t)
          : !isRetrying || status.reason === 'context-loss-limit'
            ? retryGpuAcceleration(t)
            : undefined;
    // An actionable chip leads with what clicking does, matching the `Open Process Explorer, …` chips beside it, so
    // the accessible name and the tooltip promise exactly the same thing. A confirming action's title is already a
    // question, so it reads as the promise directly.
    const summary = t('terminal.renderer.summary', { detail });
    const description = action
        ? t('terminal.renderer.withAction', { action: action.title, summary })
        : summary;
    return {
        ...(action && { action }),
        ariaLabel: description,
        label: t('terminal.renderer.label'),
        title: description,
    };
}

function terminalRendererDetail(
    status: TerminalRendererStatus,
    isBootDisabled: boolean,
    t: Translate,
): string {
    if (status.reason === 'disabled') return t('terminal.renderer.detail.disabled');
    if (isBootDisabled) return t('terminal.renderer.detail.hardwareOff');
    if (status.reason === 'unsupported') return t('terminal.renderer.detail.unsupported');
    if (status.reason === 'context-loss-limit')
        return t('terminal.renderer.detail.contextLossLimit');
    const cause = t(
        status.reason === 'context-loss'
            ? 'terminal.renderer.detail.interrupted'
            : 'terminal.renderer.detail.loadFailed',
    );
    if (status.retryState === 'exhausted')
        return t('terminal.renderer.detail.exhausted', { cause });
    if (['deferred', 'failed', 'scheduled', 'trying'].includes(status.retryState))
        return t('terminal.renderer.detail.retrying', {
            attempt: status.retryAttemptCount,
            cause,
            limit: status.retryLimit,
        });
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
