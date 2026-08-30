import type { ProcessState } from '@caxri/protocol';

import { gpuRecoveryNotificationCoordinator } from '../gpu/gpu-recovery-notifications';
import type { TerminalGpuAcceleration, TerminalRendererStatus } from './terminal-renderer';
import { createTerminalRendererDiagnostic } from './terminal-renderer-diagnostics';

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
            gpuRecoveryNotificationCoordinator.disposeTerminal(options.terminalId);
        },
        publish(status: TerminalRendererStatus): void {
            options.container.dataset.terminalRenderer = status.mode;
            options.container.dataset.terminalRendererReason = status.reason;
            options.container.dataset.terminalWebglContextLosses = String(status.contextLossCount);
            options.container.dataset.terminalRendererRedraws = String(status.redrawCount);
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
                ...(correlationId && { correlationId }),
            });
            if (diagnostic) globalThis.caxri.reportDiagnostic(diagnostic);
        },
        recordOutput(data: string, dropped: number): void {
            receivedBytes += encoder.encode(data).byteLength;
            droppedBytes += dropped;
        },
        withRecovery<T>(nextCorrelationId: string, recover: () => T): T {
            correlationId = nextCorrelationId;
            try {
                return recover();
            } finally {
                correlationId = undefined;
            }
        },
    };
}
