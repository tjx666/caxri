import { caxri } from '../../lib/caxri';
import type { ToastKind, ToastOptions } from '../../stores/toasts';
import { pushToast, tryCommand } from '../../stores/toasts';
import type { TerminalRendererStatus } from '../terminal/terminal-renderer';

const GPU_PROCESS_RECOVERY_MESSAGE =
    'A GPU process crash interrupted rendering. Caxri switched affected Terminals to software rendering.';
const GPU_ACCELERATION_PINNED_MESSAGE =
    'Caxri turned off GPU acceleration for Terminals in this window after repeated graphics failures. Restart Caxri to try again.';
const TERMINAL_GPU_FALLBACK_MESSAGE =
    'GPU rendering failed in a Terminal. Caxri switched it to software rendering.';
const GPU_INCIDENT_MERGE_MS = 500;
const MAX_REMEMBERED_GPU_INCIDENTS = 64;
const MAX_REMEMBERED_FAILED_TERMINALS = 256;

interface RendererStatusInput {
    correlationId?: string;
    status: TerminalRendererStatus;
    terminalId: string;
}

interface GpuRecoveryNotificationCoordinatorOptions {
    clearTimer(handle: number): void;
    now(): number;
    pushToast(kind: ToastKind, message: string, options?: ToastOptions): void;
    restartInGpuSafeMode(): void;
    setTimer(callback: () => void, delayMs: number): number;
}

/**
 * Joins the Main-owned GPU incident, the session-wide GPU incident budget, and per-Terminal WebGL status. Local context
 * loss may arrive shortly before or after Main's correlated event, so the bounded merge window prevents one physical
 * incident from producing both a local fallback notice and a global recovery notice. Every notice is funnelled through
 * here for that reason: one physical GPU event is one message, however many panes and processes reported it.
 */
export function createGpuRecoveryNotificationCoordinator(
    options: GpuRecoveryNotificationCoordinatorOptions,
) {
    const notifiedCorrelationIds = new Set<string>();
    const failedTerminalIds = new Set<string>();
    const pendingLocalFallbacks = new Map<string, number>();
    let lastGlobalIncidentAt: number | undefined;

    function cancelPendingLocalFallback(terminalId: string): void {
        const handle = pendingLocalFallbacks.get(terminalId);
        if (handle !== undefined) options.clearTimer(handle);
        pendingLocalFallbacks.delete(terminalId);
    }

    /**
     * Claims one physical GPU incident for the notice about to be pushed, and answers `true` only for the claim that
     * won it. Main and every pane that observed the same incident therefore still produce one message between them.
     */
    function didClaimGpuIncident(correlationId: string): boolean {
        if (notifiedCorrelationIds.has(correlationId)) return false;
        if (notifiedCorrelationIds.size >= MAX_REMEMBERED_GPU_INCIDENTS) {
            const oldestCorrelationId = notifiedCorrelationIds.values().next().value;
            if (oldestCorrelationId) notifiedCorrelationIds.delete(oldestCorrelationId);
        }
        notifiedCorrelationIds.add(correlationId);
        return true;
    }

    function rememberFailedTerminal(terminalId: string): void {
        if (failedTerminalIds.has(terminalId)) return;
        if (failedTerminalIds.size >= MAX_REMEMBERED_FAILED_TERMINALS) {
            const oldestTerminalId = failedTerminalIds.values().next().value;
            if (oldestTerminalId) failedTerminalIds.delete(oldestTerminalId);
        }
        failedTerminalIds.add(terminalId);
    }

    function coverPendingLocalFallbacks(): void {
        for (const terminalId of pendingLocalFallbacks.keys()) {
            cancelPendingLocalFallback(terminalId);
            rememberFailedTerminal(terminalId);
        }
    }

    /**
     * Opens the merge window every per-pane notice defers to, so the panes that observe the same physical incident stay
     * silent whether they report it just before or just after the session-level notice.
     */
    function beginGlobalIncident(): void {
        lastGlobalIncidentAt = options.now();
        coverPendingLocalFallbacks();
    }

    /**
     * Both GPU notices offer the same way out, so the action is described once.
     */
    function restartInGpuSafeModeAction(): NonNullable<ToastOptions['action']> {
        return {
            label: 'Restart in GPU Safe Mode',
            onSelect: () => options.restartInGpuSafeMode(),
        };
    }

    function notifyGpuProcessRecovery(correlationId: string): void {
        if (!didClaimGpuIncident(correlationId)) return;
        beginGlobalIncident();
        options.pushToast('info', GPU_PROCESS_RECOVERY_MESSAGE, {
            // Restarting in GPU Safe Mode is reachable from nowhere else: notification history deliberately keeps no
            // action callbacks, so once this card expires the recovery route is gone even though the crash it reports
            // has not been undone. A four-second window also assumes the user was watching the moment the GPU died.
            // The card therefore stays until it is dismissed, which is the choice `persist` exists to express.
            persist: true,
            action: restartInGpuSafeModeAction(),
        });
    }

    /**
     * The pinned transition is the only consequential state change in this feature: WebGL is now off for every Terminal
     * for the rest of this window's lifetime, and only restarting Caxri or changing the Settings preference brings it
     * back. Without its own notice the user sees a third copy of the same transient crash toast and never learns that
     * anything became permanent, so this one persists and carries the recovery action with it.
     */
    function notifyGpuAccelerationPinned(correlationId?: string): void {
        // Main records the incident against the budget before it asks for the crash notice, so claiming the correlation
        // here turns the crash that tripped the budget into this single escalated notice instead of a pair.
        if (correlationId) didClaimGpuIncident(correlationId);
        beginGlobalIncident();
        options.pushToast('info', GPU_ACCELERATION_PINNED_MESSAGE, {
            persist: true,
            action: restartInGpuSafeModeAction(),
        });
    }

    return {
        disposeTerminal(terminalId: string): void {
            cancelPendingLocalFallback(terminalId);
        },
        notifyGpuAccelerationPinned,
        notifyGpuProcessRecovery,
        observeTerminalRendererStatus(input: RendererStatusInput): void {
            if (input.status.mode === 'webgl' && input.status.reason === 'active') {
                cancelPendingLocalFallback(input.terminalId);
                failedTerminalIds.delete(input.terminalId);
                return;
            }
            const isLocalFallback =
                input.status.reason === 'context-loss' || input.status.reason === 'load-failed';
            if (input.correlationId) {
                cancelPendingLocalFallback(input.terminalId);
                if (isLocalFallback) rememberFailedTerminal(input.terminalId);
                notifyGpuProcessRecovery(input.correlationId);
                return;
            }
            if (
                !isLocalFallback ||
                failedTerminalIds.has(input.terminalId) ||
                pendingLocalFallbacks.has(input.terminalId)
            )
                return;
            const now = options.now();
            if (
                lastGlobalIncidentAt !== undefined &&
                now - lastGlobalIncidentAt <= GPU_INCIDENT_MERGE_MS
            ) {
                rememberFailedTerminal(input.terminalId);
                return;
            }
            const handle = options.setTimer(() => {
                pendingLocalFallbacks.delete(input.terminalId);
                rememberFailedTerminal(input.terminalId);
                options.pushToast('info', TERMINAL_GPU_FALLBACK_MESSAGE);
            }, GPU_INCIDENT_MERGE_MS);
            pendingLocalFallbacks.set(input.terminalId, handle);
        },
    };
}

export const gpuRecoveryNotificationCoordinator = createGpuRecoveryNotificationCoordinator({
    clearTimer: (handle) => clearTimeout(handle),
    now: () => Date.now(),
    pushToast,
    restartInGpuSafeMode: () => {
        // The shared command funnel turns a failed Desktop restart request into one actionable toast.
        // eslint-disable-next-line no-void -- the action is synchronous by the Toast contract
        void tryCommand('Unable to restart in GPU Safe Mode', () =>
            caxri.request('gpu.restartInSafeMode'),
        );
    },
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
});
