import { RENDERER_DIAGNOSTIC_CHANNEL } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    const handles = new Map<string, (...arguments_: unknown[]) => unknown>();
    const listeners = new Map<string, (...arguments_: unknown[]) => unknown>();
    return {
        handles,
        listeners,
        ipcMain: {
            handle: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) =>
                handles.set(channel, handler),
            ),
            on: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) =>
                listeners.set(channel, handler),
            ),
        },
    };
});

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain }));

import { installWorkbenchIpc } from '../workbench-ipc';

describe('workbench IPC sender boundary', () => {
    const renderer = {};
    const dispatch = vi.fn(() =>
        Promise.resolve({ protocolVersion: 2, id: 'r1', ok: true, result: null } as const),
    );
    const negotiate = vi.fn(() => ({
        protocolVersion: 2 as const,
        principal: { kind: 'desktop' as const, id: 'desktop-1', generation: 1 },
        capabilities: ['desktop' as const],
        commands: ['app.health'],
    }));
    const onEventsReady = vi.fn();
    const onRendererDiagnostic = vi.fn();
    const write = vi.fn();

    beforeEach(() => {
        electronMock.handles.clear();
        electronMock.listeners.clear();
        dispatch.mockClear();
        negotiate.mockClear();
        onEventsReady.mockClear();
        onRendererDiagnostic.mockClear();
        write.mockClear();
        installWorkbenchIpc({
            isQuitting: () => false,
            logger: () => ({ write }) as never,
            onEventsReady,
            onRendererDiagnostic,
            renderer: () => renderer as never,
            transport: { dispatch, negotiate },
        });
    });

    it('retains sender validation for commands and negotiation', async () => {
        const request = electronMock.handles.get('caxri:request')!;
        const hello = electronMock.handles.get('caxri:negotiate')!;
        const envelope = { protocolVersion: 2, id: 'r1', method: 'app.health', params: {} };

        await expect(request({ sender: {} }, envelope)).resolves.toMatchObject({
            id: 'r1',
            ok: false,
            error: { code: 'PATH_DENIED' },
        });
        expect(() => hello({ sender: {} }, { supportedVersions: [2] })).toThrow(
            'Untrusted IPC sender',
        );
        await expect(request({ sender: renderer }, envelope)).resolves.toMatchObject({ ok: true });
        expect(hello({ sender: renderer }, { supportedVersions: [2] })).toMatchObject({
            protocolVersion: 2,
        });
    });

    it('accepts the Renderer event-readiness signal only from the trusted workbench', () => {
        const ready = electronMock.listeners.get('caxri:renderer-events-ready')!;

        expect(() => ready({ sender: {} })).toThrow('Untrusted IPC sender');
        expect(onEventsReady).not.toHaveBeenCalled();
        ready({ sender: renderer });
        expect(onEventsReady).toHaveBeenCalledOnce();
    });

    it('accepts only strict content-free diagnostics from the trusted workbench', () => {
        const report = electronMock.listeners.get(RENDERER_DIAGNOSTIC_CHANNEL)!;
        const diagnostic = {
            kind: 'terminal-renderer',
            diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
            terminalId: 'terminal-1',
            mode: 'dom',
            reason: 'context-loss',
            trigger: 'webgl-context-loss',
            preference: 'auto',
            contextLossCount: 1,
            redrawCount: 1,
            recoveryResult: 'dom-restored',
            receivedBytes: 120,
            droppedBytes: 0,
            paneActive: true,
            terminalProcessRunning: true,
            agentTerminal: true,
            documentVisible: true,
            documentFocused: true,
            terminalFocused: false,
        };

        report({ sender: {} }, diagnostic);
        report({ sender: renderer }, { ...diagnostic, terminalOutput: 'private' });
        expect(onRendererDiagnostic).not.toHaveBeenCalled();
        report({ sender: renderer }, diagnostic);
        expect(onRendererDiagnostic).toHaveBeenCalledWith(diagnostic);
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
            },
        });
        expect(onRendererDiagnostic).not.toHaveBeenCalled();
    });

    it('does not report an in-flight request failure after application shutdown begins', async () => {
        const completion = Promise.withResolvers<{
            protocolVersion: 2;
            id: string;
            ok: false;
            error: { code: 'UNAVAILABLE'; message: string };
        }>();
        const write = vi.fn();
        let isQuitting = false;
        installWorkbenchIpc({
            isQuitting: () => isQuitting,
            logger: () => ({ write }) as never,
            renderer: () => renderer as never,
            transport: { dispatch: () => completion.promise, negotiate },
        });
        const request = electronMock.handles.get('caxri:request')!;
        const pending = request(
            { sender: renderer },
            { protocolVersion: 2, id: 'closing-read', method: 'app.health', params: {} },
        );

        isQuitting = true;
        completion.resolve({
            protocolVersion: 2,
            id: 'closing-read',
            ok: false,
            error: { code: 'UNAVAILABLE', message: 'Caxri Host connection closed' },
        });

        await expect(pending).resolves.toMatchObject({ id: 'closing-read', ok: false });
        expect(write).not.toHaveBeenCalled();
    });

    it('does not error-log a request that the Renderer deliberately cancelled', async () => {
        const write = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => false,
            logger: () => ({ write }) as never,
            renderer: () => renderer as never,
            transport: {
                dispatch: () =>
                    Promise.resolve({
                        protocolVersion: 2,
                        id: 'cancelled-view',
                        ok: false,
                        error: { code: 'CANCELLED', message: 'View request was cancelled' },
                    }),
                negotiate,
            },
        });
        const request = electronMock.handles.get('caxri:request')!;

        await expect(
            request(
                { sender: renderer },
                {
                    protocolVersion: 2,
                    id: 'cancelled-view',
                    method: 'viewContainers.viewOperation',
                    params: {},
                },
            ),
        ).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
        expect(write).not.toHaveBeenCalled();
    });
});
