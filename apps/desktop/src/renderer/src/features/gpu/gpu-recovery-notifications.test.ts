import { describe, expect, it, vi } from 'vitest';

import type { TerminalRendererStatus } from '../terminal/terminal-renderer';
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
    notifyAutomaticGpuSafeMode(): void;
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
    trigger: 'preference-change',
};

const LOCAL_FALLBACK_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    mode: 'dom',
    reason: 'context-loss',
    recoveryResult: 'not-requested',
    redrawCount: 1,
    trigger: 'webgl-context-loss',
};

const GLOBAL_RECOVERY_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    mode: 'dom',
    reason: 'context-loss',
    recoveryResult: 'dom-restored',
    redrawCount: 1,
    trigger: 'gpu-process-recovery',
};

const CORRELATED_ALREADY_DOM_STATUS: TerminalRendererStatus = {
    contextLossCount: 0,
    mode: 'dom',
    reason: 'disabled',
    recoveryResult: 'already-dom',
    redrawCount: 0,
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

    it('keeps ordinary notifications transient and gives only the global incident a restart action', () => {
        const global = createHarness();
        global.coordinator.notifyGpuProcessRecovery(CORRELATION_ID);

        expect(global.toasts).toHaveLength(1);
        expect(global.toasts[0]?.options?.persist).not.toBe(true);
        expect(global.toasts[0]?.options?.action?.label).toBe('Restart in GPU Safe Mode');
        global.toasts[0]?.options?.action?.onSelect();
        expect(global.restartInGpuSafeMode).toHaveBeenCalledOnce();

        const local = createHarness();
        local.coordinator.observeTerminalRendererStatus({
            status: LOCAL_FALLBACK_STATUS,
            terminalId: 'terminal-1',
        });
        local.scheduler.advance(500);

        expect(local.toasts).toHaveLength(1);
        expect(local.toasts[0]?.options?.persist).not.toBe(true);
        expect(local.toasts[0]?.options?.action).toBeUndefined();
    });

    it('keeps the automatic GPU Safe Mode notification persistent', () => {
        const { coordinator, toasts } = createHarness();

        coordinator.notifyAutomaticGpuSafeMode();

        expect(toasts).toHaveLength(1);
        expect(toasts[0]?.options?.persist).toBe(true);
    });
});
