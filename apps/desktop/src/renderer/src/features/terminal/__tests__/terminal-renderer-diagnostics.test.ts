import { describe, expect, it } from 'vitest';

import { createTerminalRendererDiagnostic } from '../terminal-renderer-diagnostics';

const status = {
    contextLossCount: 1,
    liveWebglContextCount: 17,
    mode: 'dom' as const,
    reason: 'context-loss' as const,
    recoveryResult: 'dom-restored' as const,
    redrawCount: 2,
    retryAttemptCount: 1,
    retryDelayMs: 1_000,
    retryLimit: 3 as const,
    retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
    retryState: 'scheduled' as const,
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
                visibilityRestoreCoalescedCount: 5,
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
            visibilityRestoreCoalescedCount: 5,
            liveWebglContextCount: 17,
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
            retryAttemptCount: 1,
            retryDelayMs: 1_000,
            retryLimit: 3,
            retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
            retryState: 'scheduled',
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
                    retryAttemptCount: 0,
                    retryDelayMs: null,
                    retrySequenceId: undefined,
                    retryState: 'idle',
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
                visibilityRestoreCoalescedCount: 0,
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
                visibilityRestoreCoalescedCount: 0,
            }),
        ).toBeDefined();
    });

    it('retains a successful retry from a visible but unfocused split pane', () => {
        expect(
            createTerminalRendererDiagnostic({
                diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                terminalId: 'terminal-1',
                status: {
                    ...status,
                    mode: 'webgl',
                    reason: 'active',
                    retryDelayMs: null,
                    retryState: 'succeeded',
                    trigger: 'webgl-retry-succeeded',
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
                visibilityRestoreCoalescedCount: 0,
            }),
        ).toBeDefined();
    });
});
