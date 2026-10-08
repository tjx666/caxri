import type { RendererDiagnostic } from '@caxri/protocol';

import type { TerminalGpuAcceleration, TerminalRendererStatus } from './terminal-renderer';

interface TerminalRendererDiagnosticInput {
    agentTerminal: boolean;
    correlationId?: string;
    diagnosticId: string;
    documentFocused: boolean;
    documentVisible: boolean;
    droppedBytes: number;
    paneActive: boolean;
    preference: TerminalGpuAcceleration;
    receivedBytes: number;
    status: TerminalRendererStatus;
    terminalFocused: boolean;
    terminalId: string;
    terminalProcessRunning: boolean;
    visibilityRestoreCoalescedCount: number;
}

/**
 * Builds the strict content-free diagnostic sent through Preload. Healthy inactive panes are omitted so one Space
 * transition cannot emit an IPC report for every persisted Terminal; failures remain observable regardless of focus.
 */
export function createTerminalRendererDiagnostic(
    input: TerminalRendererDiagnosticInput,
): RendererDiagnostic | undefined {
    if (!input.paneActive && input.status.reason === 'active' && input.status.retryState === 'idle')
        return undefined;
    return {
        kind: 'terminal-renderer',
        diagnosticId: input.diagnosticId,
        terminalId: input.terminalId,
        mode: input.status.mode,
        reason: input.status.reason,
        trigger: input.status.trigger,
        preference: input.preference,
        contextLossCount: input.status.contextLossCount,
        redrawCount: input.status.redrawCount,
        visibilityRestoreCoalescedCount: input.visibilityRestoreCoalescedCount,
        liveWebglContextCount: input.status.liveWebglContextCount,
        recoveryResult: input.status.recoveryResult,
        retryAttemptCount: input.status.retryAttemptCount,
        retryDelayMs: input.status.retryDelayMs,
        retryLimit: input.status.retryLimit,
        ...(input.status.retrySequenceId && {
            retrySequenceId: input.status.retrySequenceId,
        }),
        retryState: input.status.retryState,
        receivedBytes: input.receivedBytes,
        droppedBytes: input.droppedBytes,
        ...(input.correlationId && { correlationId: input.correlationId }),
        paneActive: input.paneActive,
        terminalProcessRunning: input.terminalProcessRunning,
        agentTerminal: input.agentTerminal,
        documentVisible: input.documentVisible,
        documentFocused: input.documentFocused,
        terminalFocused: input.terminalFocused,
    };
}
