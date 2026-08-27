import { describe, expect, it } from 'vitest';

import { createTerminalRendererDiagnostic } from '../terminal-renderer-diagnostics';

const status = {
    contextLossCount: 1,
    mode: 'dom' as const,
    reason: 'context-loss' as const,
    recoveryResult: 'dom-restored' as const,
    redrawCount: 2,
    trigger: 'webgl-context-loss' as const,
};

describe('terminal Renderer diagnostics', () => {
    it('captures only state and focus booleans for a fallback', () => {
        expect(
            createTerminalRendererDiagnostic({
                diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                terminalId: 'terminal-1',
                status,
                preference: 'auto',
                paneActive: true,
                terminalProcessRunning: true,
                agentTerminal: true,
                documentVisible: true,
                documentFocused: true,
                terminalFocused: false,
                correlationId: '75f635fb-b53f-44cf-a99d-a731f97455d8',
                droppedBytes: 7,
                receivedBytes: 42,
            }),
        ).toEqual({
            kind: 'terminal-renderer',
            diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
            terminalId: 'terminal-1',
            mode: 'dom',
            reason: 'context-loss',
            trigger: 'webgl-context-loss',
            preference: 'auto',
            contextLossCount: 1,
            redrawCount: 2,
            paneActive: true,
            terminalProcessRunning: true,
            agentTerminal: true,
            documentVisible: true,
            documentFocused: true,
            terminalFocused: false,
            correlationId: '75f635fb-b53f-44cf-a99d-a731f97455d8',
            droppedBytes: 7,
            receivedBytes: 42,
            recoveryResult: 'dom-restored',
        });
    });

    it('drops healthy status chatter from inactive panes but retains their failures', () => {
        expect(
            createTerminalRendererDiagnostic({
                diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                terminalId: 'terminal-1',
                status: {
                    ...status,
                    mode: 'webgl',
                    reason: 'active',
                    recoveryResult: 'not-requested',
                },
                preference: 'auto',
                paneActive: false,
                terminalProcessRunning: true,
                agentTerminal: false,
                documentVisible: true,
                documentFocused: true,
                terminalFocused: false,
                droppedBytes: 0,
                receivedBytes: 0,
            }),
        ).toBeUndefined();
        expect(
            createTerminalRendererDiagnostic({
                diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                terminalId: 'terminal-1',
                status: { ...status, recoveryResult: 'not-requested' },
                preference: 'auto',
                paneActive: false,
                terminalProcessRunning: true,
                agentTerminal: false,
                documentVisible: true,
                documentFocused: true,
                terminalFocused: false,
                droppedBytes: 0,
                receivedBytes: 0,
            }),
        ).toBeDefined();
    });
});
