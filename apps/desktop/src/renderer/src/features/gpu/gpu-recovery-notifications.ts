import { caxri } from '../../lib/caxri';
import type { ToastKind, ToastOptions } from '../../stores/toasts';
import { pushToast, tryCommand } from '../../stores/toasts';
import type { TerminalRendererStatus } from '../terminal/terminal-renderer';

const GPU_PROCESS_RECOVERY_MESSAGE =
    'A GPU process crash interrupted rendering. Caxri switched affected Terminals to software rendering.';
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
 * Joins the Main-owned GPU incident with per-Terminal WebGL status. Local context loss may arrive shortly before or
 * after Main's correlated event, so the bounded merge window prevents one physical incident from producing both a local
 * fallback notice and a global recovery notice.
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

    function notifyGpuProcessRecovery(correlationId: string): void {
        if (notifiedCorrelationIds.has(correlationId)) return;
        if (notifiedCorrelationIds.size >= MAX_REMEMBERED_GPU_INCIDENTS) {
            const oldestCorrelationId = notifiedCorrelationIds.values().next().value;
            if (oldestCorrelationId) notifiedCorrelationIds.delete(oldestCorrelationId);
        }
        notifiedCorrelationIds.add(correlationId);
        lastGlobalIncidentAt = options.now();
        coverPendingLocalFallbacks();
        options.pushToast('info', GPU_PROCESS_RECOVERY_MESSAGE, {
            action: {
                label: 'Restart in GPU Safe Mode',
                onSelect: () => options.restartInGpuSafeMode(),
            },
        });
    }

    return {
        disposeTerminal(terminalId: string): void {
            cancelPendingLocalFallback(terminalId);
        },
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
