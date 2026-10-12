import { translate } from '../../i18n';
import type { ToastKind, ToastOptions } from '../../stores/toasts';
import { pushToast } from '../../stores/toasts';
import type { TerminalRendererStatus } from '../terminal/terminal-renderer';

/*
 * Copy rules for the `gpu.notice.*` strings. One name for the degraded state across every notice, the confirmation, and the Settings row: the state is "software
 * rendering" and the setting that decides it is "hardware acceleration". The same condition used to answer to five
 * names at once (GPU process crash, GPU acceleration, DOM renderer, WebGL2, GPU Safe Mode), which made one physical
 * event read as several unrelated problems. Implementation words stay out of the copy entirely (DESIGN.md principle 3):
 * the user never sees a renderer name, a graphics API, or a configuration file.
 *
 * Each message also states that Terminals keep working, because a notice that only reports a failure reads as data loss
 * (DESIGN.md principle 9).
 *
 * `gpu.notice.gpuProcessRecovery` names the status bar's own recovery path instead of implying a restart is the only way
 * back: the "Software" renderer chip already retries GPU rendering for the affected Terminal without a restart
 * (DESIGN.md "Status bar"), and the previous wording never told the reader that chip existed. The toast's own action
 * stays "Turn off hardware acceleration…", the other of the two recovery routes that DESIGN.md section documents.
 */

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
     * The escape hatch offered while hardware acceleration is still on: stop using it, from the next launch onward. The
     * trailing ellipsis is the standard promise that a question comes first: the click itself changes nothing, which is
     * what separates this from the version that wrote the boot configuration on the first click.
     */
    function turnOffHardwareAccelerationAction(): NonNullable<ToastOptions['action']> {
        return { id: 'settings.turnOffHardwareAcceleration' };
    }

    /**
     * The route offered once this window has already stopped using the GPU. Repeating "turn it off" there would ask the
     * user to buy relief they already have for this session; what is left to decide is the durable preference for later
     * launches, and a preference belongs in Settings. Hardware acceleration itself is still on (the pin is a
     * Renderer-session state and never writes the boot configuration) so the copy must not claim otherwise. This is
     * also the only place that answer stays reachable after the card is dismissed.
     */
    function openSettingsAction(): NonNullable<ToastOptions['action']> {
        return { id: 'settings.openHardwareAcceleration' };
    }

    function notifyGpuProcessRecovery(correlationId: string): void {
        if (!didClaimGpuIncident(correlationId)) return;
        beginGlobalIncident();
        options.pushToast('warning', translate('gpu.notice.gpuProcessRecovery'), {
            // The offer is reachable from nowhere else: notification history deliberately keeps no action callbacks, so
            // once this card expires the route is gone even though the crash it reports has not been undone. A
            // four-second window also assumes the user was watching the moment drawing failed. The card therefore stays
            // until it is dismissed, which is the choice `persist` exists to express.
            persist: true,
            action: turnOffHardwareAccelerationAction(),
        });
    }

    /**
     * The pinned transition is the only consequential state change in this feature: every Terminal now draws with
     * software rendering for the rest of this window's lifetime, and only restarting Caxri or changing the Settings
     * preference moves it. Without its own notice the user sees a third copy of the same transient crash toast and
     * never learns that the session changed, so this one persists and carries the Settings route with it.
     */
    function notifySoftwareRenderingPinned(correlationId?: string): void {
        // Main records the incident against the budget before it asks for the crash notice, so claiming the correlation
        // here turns the crash that tripped the budget into this single escalated notice instead of a pair.
        if (correlationId) didClaimGpuIncident(correlationId);
        beginGlobalIncident();
        options.pushToast('warning', translate('gpu.notice.softwareRenderingPinned'), {
            persist: true,
            action: openSettingsAction(),
        });
    }

    return {
        disposeTerminal(terminalId: string): void {
            cancelPendingLocalFallback(terminalId);
        },
        notifyGpuProcessRecovery,
        notifySoftwareRenderingPinned,
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
                options.pushToast('warning', translate('gpu.notice.terminalFallback'));
            }, GPU_INCIDENT_MERGE_MS);
            pendingLocalFallbacks.set(input.terminalId, handle);
        },
    };
}

export const gpuRecoveryNotificationCoordinator = createGpuRecoveryNotificationCoordinator({
    clearTimer: (handle) => clearTimeout(handle),
    now: () => Date.now(),
    pushToast,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
});
