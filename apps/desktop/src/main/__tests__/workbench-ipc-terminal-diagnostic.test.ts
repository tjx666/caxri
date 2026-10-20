import { RENDERER_DIAGNOSTIC_CHANNEL } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    const listeners = new Map<string, (...arguments_: unknown[]) => unknown>();
    return {
        listeners,
        ipcMain: {
            handle: vi.fn(),
            on: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) =>
                listeners.set(channel, handler),
            ),
        },
    };
});

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain }));

import { installWorkbenchIpc } from '../workbench-ipc';

/**
 * The Terminal diagnostics Main logs itself rather than handing to GPU diagnostics. Each is accepted only in its strict
 * content-free shape and only from a trusted sender.
 */
describe('workbench IPC Terminal diagnostics', () => {
    const renderer = {};
    const onRendererDiagnostic = vi.fn();
    const write = vi.fn();

    beforeEach(() => {
        electronMock.listeners.clear();
        onRendererDiagnostic.mockClear();
        write.mockClear();
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => ({ write }) as never,
            onRendererDiagnostic,
            isWorkbenchSender: (sender) => sender === (renderer as never),
            transport: { dispatch: vi.fn(), negotiate: vi.fn() },
        });
    });

    it('logs a session GPU incident budget transition with its Main incident correlation', () => {
        const report = electronMock.listeners.get(RENDERER_DIAGNOSTIC_CHANNEL)!;
        const diagnostic = {
            kind: 'gpu-incident-budget',
            diagnosticId: '5c85eb53-a828-4656-b7ad-1e77bf2baf27',
            transition: 'pinned',
            cause: 'gpu-incident',
            correlationId: '75f635fb-b53f-44cf-a99d-a731f97455d8',
            incidentCount: 3,
            contextLossEpisodeCount: 2,
            threshold: 3,
            preference: 'on',
        };

        report({ sender: {} }, diagnostic);
        report({ sender: renderer }, { ...diagnostic, message: 'private' });
        expect(write).not.toHaveBeenCalled();

        report({ sender: renderer }, diagnostic);
        report(
            { sender: renderer },
            {
                ...diagnostic,
                transition: 'reset',
                cause: 'preference-change',
                correlationId: undefined,
            },
        );

        expect(write).toHaveBeenNthCalledWith(1, 'warn', 'gpu.session_budget', {
            correlationId: diagnostic.correlationId,
            fields: {
                code: 'GPU_SESSION_BUDGET',
                diagnosticId: diagnostic.diagnosticId,
                transition: 'pinned',
                cause: 'gpu-incident',
                incidentCount: 3,
                contextLossEpisodeCount: 2,
                threshold: 3,
                preference: 'on',
                window: 'workbench',
            },
        });
        expect(write).toHaveBeenNthCalledWith(2, 'info', 'gpu.session_budget', {
            correlationId: undefined,
            fields: {
                code: 'GPU_SESSION_BUDGET',
                diagnosticId: diagnostic.diagnosticId,
                transition: 'reset',
                cause: 'preference-change',
                incidentCount: 3,
                contextLossEpisodeCount: 2,
                threshold: 3,
                preference: 'on',
                window: 'workbench',
            },
        });
        expect(onRendererDiagnostic).not.toHaveBeenCalled();
    });

    it('logs one trusted Renderer resize burst without routing it into GPU diagnostics', () => {
        const report = electronMock.listeners.get(RENDERER_DIAGNOSTIC_CHANNEL)!;
        const diagnostic = {
            kind: 'terminal-resize-burst',
            diagnosticId: '5c85eb53-a828-4656-b7ad-1e77bf2baf27',
            terminalId: 'terminal-1',
            side: 'renderer-xterm',
            sampleCount: 4,
            changeCount: 2,
            startCols: 120,
            startRows: 40,
            minCols: 4,
            minRows: 12,
            maxCols: 120,
            maxRows: 40,
            finalCols: 80,
            finalRows: 30,
            durationMs: 96,
            flushReason: 'quiet',
            truncated: false,
            localAppliedCount: 2,
            requestCount: 2,
        };

        report({ sender: {} }, diagnostic);
        report({ sender: renderer }, { ...diagnostic, terminalOutput: 'private transcript' });
        expect(write).not.toHaveBeenCalled();
        expect(onRendererDiagnostic).not.toHaveBeenCalled();

        report({ sender: renderer }, diagnostic);

        expect(write).toHaveBeenCalledOnce();
        expect(write).toHaveBeenCalledWith('info', 'renderer.terminal_resize_burst', {
            fields: {
                code: 'TERMINAL_RESIZE_BURST',
                diagnosticId: diagnostic.diagnosticId,
                terminalId: diagnostic.terminalId,
                side: diagnostic.side,
                sampleCount: diagnostic.sampleCount,
                changeCount: diagnostic.changeCount,
                startCols: diagnostic.startCols,
                startRows: diagnostic.startRows,
                minCols: diagnostic.minCols,
                minRows: diagnostic.minRows,
                maxCols: diagnostic.maxCols,
                maxRows: diagnostic.maxRows,
                finalCols: diagnostic.finalCols,
                finalRows: diagnostic.finalRows,
                durationMs: diagnostic.durationMs,
                flushReason: diagnostic.flushReason,
                truncated: diagnostic.truncated,
                localAppliedCount: diagnostic.localAppliedCount,
                requestCount: diagnostic.requestCount,
                window: 'workbench',
            },
        });
        expect(onRendererDiagnostic).not.toHaveBeenCalled();
    });

    it('logs one trusted content-free OSC 52 clipboard failure', () => {
        const report = electronMock.listeners.get(RENDERER_DIAGNOSTIC_CHANNEL)!;
        const diagnostic = {
            kind: 'terminal-osc52-clipboard-write-failure',
            diagnosticId: 'bc3db163-6b13-4b50-81f4-126c55cc429b',
            terminalId: 'terminal-1',
            errorCategory: 'not-allowed',
            clipboardWritePermission: 'granted',
            documentVisible: true,
            documentFocused: true,
            secureContext: true,
            terminalFocused: true,
            userActivationActive: false,
            userActivationHasBeenActive: true,
        };

        report({ sender: {} }, diagnostic);
        report({ sender: renderer }, { ...diagnostic, errorMessage: 'private clipboard detail' });
        expect(write).not.toHaveBeenCalled();

        report({ sender: renderer }, diagnostic);

        expect(write).toHaveBeenCalledExactlyOnceWith(
            'warn',
            'renderer.terminal_osc52_clipboard_write_failed',
            {
                fields: {
                    code: 'TERMINAL_OSC52_CLIPBOARD_WRITE_FAILED',
                    diagnosticId: diagnostic.diagnosticId,
                    terminalId: diagnostic.terminalId,
                    errorCategory: diagnostic.errorCategory,
                    clipboardWritePermission: diagnostic.clipboardWritePermission,
                    documentVisible: diagnostic.documentVisible,
                    documentFocused: diagnostic.documentFocused,
                    secureContext: diagnostic.secureContext,
                    terminalFocused: diagnostic.terminalFocused,
                    userActivationActive: diagnostic.userActivationActive,
                    userActivationHasBeenActive: diagnostic.userActivationHasBeenActive,
                    window: 'workbench',
                },
            },
        );
        expect(onRendererDiagnostic).not.toHaveBeenCalled();
    });
});
