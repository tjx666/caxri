import { describe, expect, it, vi } from 'vitest';

import type { TerminalRendererStatus } from '../terminal/terminal-renderer';
import { createGpuIncidentBudget, GPU_INCIDENT_PIN_THRESHOLD } from './gpu-incident-budget';
import { createGpuRecoveryNotificationCoordinator } from './gpu-recovery-notifications';

type TimerHandle = number;

interface ToastAction {
    label: string;
    onSelect: () => void;
}

interface ToastOptions {
    action?: ToastAction;
    persist?: boolean;
}

interface RecordedToast {
    kind: 'error' | 'info' | 'success';
    message: string;
    options?: ToastOptions;
}

interface RendererStatusInput {
    correlationId?: string;
    status: TerminalRendererStatus;
    terminalId: string;
}

interface GpuRecoveryNotificationCoordinator {
    disposeTerminal(terminalId: string): void;
    notifyGpuAccelerationPinned(correlationId?: string): void;
    notifyGpuProcessRecovery(correlationId: string): void;
    observeTerminalRendererStatus(input: RendererStatusInput): void;
}

const CORRELATION_ID = '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae';

const ACTIVE_WEBGL_STATUS: TerminalRendererStatus = {
    contextLossCount: 0,
    mode: 'webgl',
    reason: 'active',
    recoveryResult: 'not-requested',
    redrawCount: 0,
    retryAttemptCount: 0,
    retryDelayMs: null,
    retryLimit: 3,
    retryState: 'idle',
    trigger: 'preference-change',
};

const LOCAL_FALLBACK_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    mode: 'dom',
    reason: 'context-loss',
    recoveryResult: 'not-requested',
    redrawCount: 1,
    retryAttemptCount: 0,
    retryDelayMs: 1_000,
    retryLimit: 3,
    retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
    retryState: 'scheduled',
    trigger: 'webgl-context-loss',
};

const GLOBAL_RECOVERY_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    mode: 'dom',
    reason: 'context-loss',
    recoveryResult: 'dom-restored',
    redrawCount: 1,
    retryAttemptCount: 0,
    retryDelayMs: 1_000,
    retryLimit: 3,
    retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
    retryState: 'scheduled',
    trigger: 'gpu-process-recovery',
};

/**
 * What every pane publishes once the session budget has pinned: the retry sequence is closed, so the pane reports the
 * settled reason instead of another local fallback.
 */
const PINNED_LIMIT_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    mode: 'dom',
    reason: 'context-loss-limit',
    recoveryResult: 'dom-restored',
    redrawCount: 1,
    retryAttemptCount: 0,
    retryDelayMs: null,
    retryLimit: 3,
    retryState: 'idle',
    trigger: 'gpu-process-recovery',
};

const CORRELATED_ALREADY_DOM_STATUS: TerminalRendererStatus = {
    contextLossCount: 0,
    mode: 'dom',
    reason: 'disabled',
    recoveryResult: 'already-dom',
    redrawCount: 0,
    retryAttemptCount: 0,
    retryDelayMs: null,
    retryLimit: 3,
    retryState: 'idle',
    trigger: 'gpu-process-recovery',
};

class ManualScheduler {
    private currentTime = 0;
    private nextHandle = 1;
    private readonly tasks = new Map<TimerHandle, { callback: () => void; dueAt: number }>();

    readonly clearTimer = (handle: TimerHandle): void => {
        this.tasks.delete(handle);
    };

    readonly now = (): number => this.currentTime;

    readonly setTimer = (callback: () => void, delayMs: number): TimerHandle => {
        const handle = this.nextHandle;
        this.nextHandle += 1;
        this.tasks.set(handle, { callback, dueAt: this.currentTime + delayMs });
        return handle;
    };

    advance(milliseconds: number): void {
        const targetTime = this.currentTime + milliseconds;
        while (true) {
            const next = this.tasks
                .entries()
                .filter(([, task]) => task.dueAt <= targetTime)
                .toArray()
                .toSorted(
                    ([firstHandle, first], [secondHandle, second]) =>
                        first.dueAt - second.dueAt || firstHandle - secondHandle,
                )
                .at(0);
            if (!next) break;
            const [handle, task] = next;
            this.tasks.delete(handle);
            this.currentTime = task.dueAt;
            task.callback();
        }
        this.currentTime = targetTime;
    }
}

function createHarness(): {
    coordinator: GpuRecoveryNotificationCoordinator;
    restartInGpuSafeMode: ReturnType<typeof vi.fn>;
    scheduler: ManualScheduler;
    toasts: RecordedToast[];
} {
    const scheduler = new ManualScheduler();
    const restartInGpuSafeMode = vi.fn();
    const toasts: RecordedToast[] = [];
    const coordinator = createGpuRecoveryNotificationCoordinator({
        clearTimer: scheduler.clearTimer,
        now: scheduler.now,
        pushToast: (kind, message, options) => toasts.push({ kind, message, options }),
        restartInGpuSafeMode,
        setTimer: scheduler.setTimer,
    });
    return { coordinator, restartInGpuSafeMode, scheduler, toasts };
}

describe('GPU recovery notification coordinator', () => {
    it('shows one global notification for one correlation across Workbench and every Terminal', () => {
        const { coordinator, scheduler, toasts } = createHarness();

        coordinator.notifyGpuProcessRecovery(CORRELATION_ID);
        coordinator.observeTerminalRendererStatus({
            correlationId: CORRELATION_ID,
            status: GLOBAL_RECOVERY_STATUS,
            terminalId: 'terminal-1',
        });
        coordinator.observeTerminalRendererStatus({
            correlationId: CORRELATION_ID,
            status: GLOBAL_RECOVERY_STATUS,
            terminalId: 'terminal-2',
        });
        scheduler.advance(5_000);
        coordinator.notifyGpuProcessRecovery(CORRELATION_ID);

        expect(toasts).toHaveLength(1);
    });

    it('keeps only a bounded window of handled GPU incident identities', () => {
        const { coordinator, toasts } = createHarness();

        for (let index = 0; index < 65; index += 1)
            coordinator.notifyGpuProcessRecovery(`incident-${index}`);
        coordinator.notifyGpuProcessRecovery('incident-0');

        expect(toasts).toHaveLength(66);
    });

    it('cancels a pending local fallback when the global incident arrives within 500ms', () => {
        const { coordinator, scheduler, toasts } = createHarness();

        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(499);
        expect(toasts).toEqual([]);

        coordinator.notifyGpuProcessRecovery(CORRELATION_ID);
        scheduler.advance(1_000);

        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.message).toContain('GPU process');
    });

    it('suppresses a local fallback within 500ms after a global incident but allows a later one', () => {
        const { coordinator, scheduler, toasts } = createHarness();

        coordinator.notifyGpuProcessRecovery(CORRELATION_ID);
        scheduler.advance(499);
        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-covered',
        });
        scheduler.advance(2);
        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-independent',
        });
        scheduler.advance(500);

        expect(toasts).toHaveLength(2);
        expect(toasts[0]?.message).toContain('GPU process');
        expect(toasts[1]?.message).toContain('Terminal');
    });

    it('deduplicates a local fallback by Terminal until WebGL becomes active again', () => {
        const { coordinator, scheduler, toasts } = createHarness();

        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(500);
        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(500);
        expect(toasts).toHaveLength(1);

        coordinator.observeTerminalRendererStatus({
            status: ACTIVE_WEBGL_STATUS,
            terminalId: 'terminal-1',
        });
        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(500);

        expect(toasts).toHaveLength(2);
    });

    it('cancels a pending notice on disposal while preserving deduplication across remounts', () => {
        const { coordinator, scheduler, toasts } = createHarness();

        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        coordinator.disposeTerminal('terminal-1');
        scheduler.advance(500);
        expect(toasts).toEqual([]);

        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(500);
        expect(toasts).toHaveLength(1);

        coordinator.disposeTerminal('terminal-1');
        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(500);
        expect(toasts).toHaveLength(1);
    });

    it('does not mark an already-DOM Terminal as failed during a global incident', () => {
        const { coordinator, scheduler, toasts } = createHarness();

        coordinator.observeTerminalRendererStatus({
            correlationId: CORRELATION_ID,
            status: CORRELATED_ALREADY_DOM_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(501);
        coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        scheduler.advance(500);

        expect(toasts).toHaveLength(2);
        expect(toasts[0]?.message).toContain('GPU process');
        expect(toasts[1]?.message).toContain('Terminal');
    });

    it('keeps an actionable GPU notice on screen and leaves the per-Terminal reminder transient', () => {
        const global = createHarness();
        global.coordinator.notifyGpuProcessRecovery(CORRELATION_ID);

        expect(global.toasts).toHaveLength(1);
        // Notification history never stores callbacks, so an expiring card takes the only Safe Mode route with it.
        expect(global.toasts[0]?.options?.persist).toBe(true);
        expect(global.toasts[0]?.options?.action?.label).toBe('Restart in GPU Safe Mode');
        global.toasts[0]?.options?.action?.onSelect();
        expect(global.restartInGpuSafeMode).toHaveBeenCalledOnce();

        const local = createHarness();
        local.coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        local.scheduler.advance(500);

        // Carrying no action, this one loses nothing when it expires: history keeps the whole message.
        expect(local.toasts).toHaveLength(1);
        expect(local.toasts[0]?.options?.persist).not.toBe(true);
        expect(local.toasts[0]?.options?.action).toBeUndefined();
    });

    it('announces the pinned session once, with the Safe Mode route, until the user dismisses it', () => {
        const { coordinator, restartInGpuSafeMode, toasts } = createHarness();

        coordinator.notifyGpuAccelerationPinned();

        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.kind).toBe('info');
        expect(toasts[0]?.message).toBe(
            'Caxri turned off GPU acceleration for Terminals in this window after repeated graphics failures. Restart Caxri to try again.',
        );
        expect(toasts[0]?.options?.persist).toBe(true);
        toasts[0]?.options?.action?.onSelect();
        expect(restartInGpuSafeMode).toHaveBeenCalledOnce();
    });

    it('replaces the crash notice of the incident that pinned the session instead of adding to it', () => {
        const { coordinator, scheduler, toasts } = createHarness();

        // Main records the incident against the budget first, so the pinned transition claims the correlation.
        coordinator.notifyGpuAccelerationPinned(CORRELATION_ID);
        coordinator.notifyGpuProcessRecovery(CORRELATION_ID);
        for (const terminalId of ['terminal-1', 'terminal-2', 'terminal-3'])
            coordinator.observeTerminalRendererStatus({
                correlationId: CORRELATION_ID,
                status: PINNED_LIMIT_STATUS,
                terminalId,
            });
        scheduler.advance(5_000);

        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.options?.persist).toBe(true);
        expect(toasts[0]?.message).toContain('turned off GPU acceleration');
    });

    it('merges the split panes of a context-loss pin, whichever side reports first', () => {
        const early = createHarness();
        // A pane whose loss is still inside the merge window when the budget trips.
        early.coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        early.scheduler.advance(100);
        early.coordinator.notifyGpuAccelerationPinned();
        early.scheduler.advance(5_000);

        expect(early.toasts).toHaveLength(1);
        expect(early.toasts[0]?.message).toContain('turned off GPU acceleration');

        const late = createHarness();
        // The ordinary order: the losing pane trips the budget before it publishes its own status.
        late.coordinator.notifyGpuAccelerationPinned();
        late.coordinator.observeTerminalRendererStatus({
            status: PINNED_LIMIT_STATUS,
            terminalId: 'terminal-1',
        });
        for (const terminalId of ['terminal-2', 'terminal-3'])
            late.coordinator.observeTerminalRendererStatus({
                status: LOCAL_FALLBACK_STATUS,
                terminalId,
            });
        late.scheduler.advance(5_000);

        expect(late.toasts).toHaveLength(1);
        expect(late.toasts[0]?.message).toContain('turned off GPU acceleration');
    });

    it('reports one notice per GPU crash and escalates only the crash that pins the session', () => {
        const { coordinator, scheduler, toasts } = createHarness();
        // Wired exactly as the Renderer singletons are: the budget owns the transition, the coordinator owns the notice.
        const budget = createGpuIncidentBudget({
            onPinned: (transition) =>
                coordinator.notifyGpuAccelerationPinned(transition.correlationId),
            probeWebgl2: () => true,
        });
        budget.applyPreference('on');

        for (let incident = 1; incident <= GPU_INCIDENT_PIN_THRESHOLD; incident += 1) {
            const correlationId = `incident-${incident}`;
            budget.recordIncident(correlationId);
            coordinator.notifyGpuProcessRecovery(correlationId);
            // Two split panes observe every one of those incidents.
            for (const terminalId of ['terminal-1', 'terminal-2'])
                coordinator.observeTerminalRendererStatus({
                    correlationId,
                    status:
                        incident === GPU_INCIDENT_PIN_THRESHOLD
                            ? PINNED_LIMIT_STATUS
                            : GLOBAL_RECOVERY_STATUS,
                    terminalId,
                });
            scheduler.advance(5_000);
        }

        expect(toasts.map((entry) => entry.options?.persist)).toEqual([true, true, true]);
        expect(toasts[0]?.message).toContain('GPU process crash');
        expect(toasts[1]?.message).toContain('GPU process crash');
        expect(toasts[2]?.message).toContain('turned off GPU acceleration');
    });
});
