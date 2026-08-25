import type { RendererDiagnostic } from '@shared/renderer-diagnostic';

import type { TerminalGpuAcceleration, TerminalRendererStatus } from './terminal-renderer';

interface TerminalRendererDiagnosticInput {
    agentTerminal: boolean;
    diagnosticId: string;
    documentFocused: boolean;
    documentVisible: boolean;
    paneActive: boolean;
    preference: TerminalGpuAcceleration;
    status: TerminalRendererStatus;
    terminalFocused: boolean;
    terminalId: string;
    terminalProcessRunning: boolean;
}

/**
 * Builds the strict content-free diagnostic sent through Preload. Healthy inactive panes are omitted so one Space
 * transition cannot emit an IPC report for every persisted Terminal; failures remain observable regardless of focus.
 */
export function createTerminalRendererDiagnostic(
    input: TerminalRendererDiagnosticInput,
): RendererDiagnostic | undefined {
    if (!input.paneActive && input.status.reason === 'active') return undefined;
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
        paneActive: input.paneActive,
        terminalProcessRunning: input.terminalProcessRunning,
        agentTerminal: input.agentTerminal,
        documentVisible: input.documentVisible,
        documentFocused: input.documentFocused,
        terminalFocused: input.terminalFocused,
    };
}
