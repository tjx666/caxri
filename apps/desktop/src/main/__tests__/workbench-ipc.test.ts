import { CaxriError, RENDERER_DIAGNOSTIC_CHANNEL } from '@caxri/protocol';
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
            isRecovering: () => false,
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
            visibilityRestoreCoalescedCount: 0,
            liveWebglContextCount: 3,
            recoveryResult: 'dom-restored',
            retryAttemptCount: 1,
            retryDelayMs: 1_000,
            retryLimit: 3,
            retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
            retryState: 'scheduled',
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
        expect(onRendererDiagnostic).toHaveBeenCalledWith(diagnostic, 'workbench');
    });

    /**
     * The Renderer's failure funnel stays silent for a cancellation, which is what a refusal issued while the window is
     * being torn down has to be: an outage code raised a real error notification over a closing window.
     */
    it('refuses a request queued after shutdown begins as a cancellation', async () => {
        const dispatch = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => true,
            isRecovering: () => false,
            logger: () => ({ write: vi.fn() }) as never,
            renderer: () => renderer as never,
            transport: { dispatch, negotiate },
        });
        const request = electronMock.handles.get('caxri:request')!;

        await expect(
            request(
                { sender: renderer },
                { protocolVersion: 2, id: 'quitting-read', method: 'app.health', params: {} },
            ),
        ).resolves.toMatchObject({
            error: { code: 'CANCELLED', message: 'Application is quitting' },
            id: 'quitting-read',
            ok: false,
        });
        expect(dispatch).not.toHaveBeenCalled();
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
            isRecovering: () => false,
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
            isRecovering: () => false,
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

    it('logs a caller-side NOT_FOUND request failure at warn with correlation and method', async () => {
        const write = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => ({ write }) as never,
            renderer: () => renderer as never,
            transport: {
                dispatch: () =>
                    Promise.resolve({
                        protocolVersion: 2,
                        id: 'not-found-1',
                        ok: false,
                        error: { code: 'NOT_FOUND', message: 'Session not found' },
                    }),
                negotiate,
            },
        });
        const request = electronMock.handles.get('caxri:request')!;

        await request(
            { sender: renderer },
            { protocolVersion: 2, id: 'not-found-1', method: 'sessions.select', params: {} },
        );

        expect(write).toHaveBeenCalledExactlyOnceWith('warn', 'ipc.request_failed', {
            correlationId: 'not-found-1',
            fields: { code: 'NOT_FOUND', error: 'Session not found', method: 'sessions.select' },
        });
    });

    it('logs a caller-side VALIDATION request failure at warn', async () => {
        const write = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => ({ write }) as never,
            renderer: () => renderer as never,
            transport: {
                dispatch: () =>
                    Promise.resolve({
                        protocolVersion: 2,
                        id: 'validation-1',
                        ok: false,
                        error: { code: 'VALIDATION', message: 'Path contains a null byte' },
                    }),
                negotiate,
            },
        });
        const request = electronMock.handles.get('caxri:request')!;

        await request(
            { sender: renderer },
            { protocolVersion: 2, id: 'validation-1', method: 'pathBrowser.list', params: {} },
        );

        expect(write).toHaveBeenCalledExactlyOnceWith('warn', 'ipc.request_failed', {
            correlationId: 'validation-1',
            fields: {
                code: 'VALIDATION',
                error: 'Path contains a null byte',
                method: 'pathBrowser.list',
            },
        });
    });

    it('still logs a non-caller-side request failure at error with correlation and method', async () => {
        const write = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => ({ write }) as never,
            renderer: () => renderer as never,
            transport: {
                dispatch: () =>
                    Promise.resolve({
                        protocolVersion: 2,
                        id: 'io-1',
                        ok: false,
                        error: { code: 'IO', message: 'Disk read failed' },
                    }),
                negotiate,
            },
        });
        const request = electronMock.handles.get('caxri:request')!;

        await request(
            { sender: renderer },
            { protocolVersion: 2, id: 'io-1', method: 'files.read', params: {} },
        );

        expect(write).toHaveBeenCalledExactlyOnceWith('error', 'ipc.request_failed', {
            correlationId: 'io-1',
            fields: { code: 'IO', error: 'Disk read failed', method: 'files.read' },
        });
    });

    it.each([
        ['warn', true],
        ['error', false],
    ] as const)(
        'logs an UNAVAILABLE request failure at %s while recovering is %s',
        async (level, isRecovering) => {
            const write = vi.fn();
            installWorkbenchIpc({
                isQuitting: () => false,
                isRecovering: () => isRecovering,
                logger: () => ({ write }) as never,
                renderer: () => renderer as never,
                transport: {
                    dispatch: () =>
                        Promise.resolve({
                            protocolVersion: 2,
                            id: 'wake-1',
                            ok: false,
                            error: {
                                code: 'UNAVAILABLE',
                                message: 'Desktop is not connected to the Caxri Host',
                            },
                        }),
                    negotiate,
                },
            });
            const request = electronMock.handles.get('caxri:request')!;

            await request(
                { sender: renderer },
                { protocolVersion: 2, id: 'wake-1', method: 'sessions.list', params: {} },
            );

            expect(write).toHaveBeenCalledExactlyOnceWith(level, 'ipc.request_failed', {
                correlationId: 'wake-1',
                fields: {
                    code: 'UNAVAILABLE',
                    error: 'Desktop is not connected to the Caxri Host',
                    method: 'sessions.list',
                },
            });
        },
    );

    it('keeps a non-UNAVAILABLE failure at error even while the connection is recovering', async () => {
        const write = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => true,
            logger: () => ({ write }) as never,
            renderer: () => renderer as never,
            transport: {
                dispatch: () =>
                    Promise.resolve({
                        protocolVersion: 2,
                        id: 'io-2',
                        ok: false,
                        error: { code: 'IO', message: 'Disk read failed' },
                    }),
                negotiate,
            },
        });
        const request = electronMock.handles.get('caxri:request')!;

        await request(
            { sender: renderer },
            { protocolVersion: 2, id: 'io-2', method: 'files.read', params: {} },
        );

        expect(write).toHaveBeenCalledExactlyOnceWith('error', 'ipc.request_failed', {
            correlationId: 'io-2',
            fields: { code: 'IO', error: 'Disk read failed', method: 'files.read' },
        });
    });

    /**
     * The recovery window reaches the `catch` branch too: a dispatch that rejects rather than returning a failed reply
     * is the same expected outage, so both failure log sites must classify it identically.
     */
    it.each([
        ['warn', true],
        ['error', false],
    ] as const)(
        'logs a thrown UNAVAILABLE failure at %s while recovering is %s',
        async (level, isRecovering) => {
            const write = vi.fn();
            installWorkbenchIpc({
                isQuitting: () => false,
                isRecovering: () => isRecovering,
                logger: () => ({ write }) as never,
                renderer: () => renderer as never,
                transport: {
                    dispatch: () =>
                        Promise.reject(
                            new CaxriError(
                                'UNAVAILABLE',
                                'Desktop is not connected to the Caxri Host',
                            ),
                        ),
                    negotiate,
                },
            });
            const request = electronMock.handles.get('caxri:request')!;

            const reply = await request(
                { sender: renderer },
                { protocolVersion: 2, id: 'wake-2', method: 'sessions.list', params: {} },
            );

            expect(reply).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
            expect(write).toHaveBeenCalledExactlyOnceWith(level, 'ipc.request_failed', {
                correlationId: 'wake-2',
                fields: {
                    code: 'UNAVAILABLE',
                    error: 'Desktop is not connected to the Caxri Host',
                    method: 'sessions.list',
                },
            });
        },
    );
});
