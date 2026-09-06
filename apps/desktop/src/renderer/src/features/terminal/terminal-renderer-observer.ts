import type { ProcessState } from '@caxri/protocol';

import { gpuRecoveryNotificationCoordinator } from '../gpu/gpu-recovery-notifications';
import type { TerminalGpuAcceleration, TerminalRendererStatus } from './terminal-renderer';
import { createTerminalRendererDiagnostic } from './terminal-renderer-diagnostics';
import {
    clearTerminalRendererStatus,
    publishTerminalRendererStatus,
} from './terminal-renderer-status';
import { terminalVisibilityRestoreScheduler } from './terminal-visibility-restore';

interface TerminalRendererObserverState {
    active: boolean;
    gpuAcceleration: TerminalGpuAcceleration;
    isAgent: boolean;
    processState: ProcessState;
}

interface TerminalRendererObserverOptions {
    container: HTMLElement;
    current(): TerminalRendererObserverState;
    terminalId: string;
}

/**
 * Owns the content-free counters and correlation context around one mounted Terminal renderer.
 */
export function createTerminalRendererObserver(options: TerminalRendererObserverOptions) {
    const encoder = new TextEncoder();
    let correlationId: string | undefined;
    let droppedBytes = 0;
    let receivedBytes = 0;

    return {
        dispose(): void {
            clearTerminalRendererStatus(options.terminalId);
            gpuRecoveryNotificationCoordinator.disposeTerminal(options.terminalId);
        },
        publish(status: TerminalRendererStatus): void {
            options.container.dataset.terminalRenderer = status.mode;
            options.container.dataset.terminalRendererReason = status.reason;
            options.container.dataset.terminalWebglContextLosses = String(status.contextLossCount);
            options.container.dataset.terminalRendererRedraws = String(status.redrawCount);
            options.container.dataset.terminalRendererRetryAttempts = String(
                status.retryAttemptCount,
            );
            options.container.dataset.terminalRendererRetryState = status.retryState;
            publishTerminalRendererStatus(options.terminalId, status);
            gpuRecoveryNotificationCoordinator.observeTerminalRendererStatus({
                status,
                terminalId: options.terminalId,
                ...(correlationId && { correlationId }),
            });
            const current = options.current();
            const diagnostic = createTerminalRendererDiagnostic({
                agentTerminal: current.isAgent,
                diagnosticId: crypto.randomUUID(),
                documentFocused: document.hasFocus(),
                documentVisible: document.visibilityState === 'visible',
                droppedBytes,
                paneActive: current.active,
                preference: current.gpuAcceleration,
                receivedBytes,
                status,
                terminalFocused: options.container.contains(document.activeElement),
                terminalId: options.terminalId,
                terminalProcessRunning: current.processState === 'running',
                visibilityRestoreCoalescedCount:
                    terminalVisibilityRestoreScheduler.coalescedCount(),
                ...(correlationId && { correlationId }),
            });
            if (diagnostic) globalThis.caxri.reportDiagnostic(diagnostic);
            if (
                correlationId &&
                (['cancelled', 'exhausted', 'succeeded'].includes(status.retryState) ||
                    (status.trigger === 'gpu-process-recovery' && status.retryState === 'idle'))
            )
                correlationId = undefined;
        },
        recordOutput(data: string, dropped: number): void {
            receivedBytes += encoder.encode(data).byteLength;
            droppedBytes += dropped;
        },
        withRecovery<T>(nextCorrelationId: string, recover: () => T): T {
            /**
             * A later physical GPU incident owns subsequent diagnostics while the mounted Terminal keeps one stable
             * retry sequence for its bounded recovery chain.
             */
            correlationId = nextCorrelationId;
            return recover();
        },
    };
}
