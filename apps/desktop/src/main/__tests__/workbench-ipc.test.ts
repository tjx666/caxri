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
                },
            },
        );
        expect(onRendererDiagnostic).not.toHaveBeenCalled();
    });

    it('logs a trusted Renderer performance scenario as flat Agent-queryable fields', () => {
        const report = electronMock.listeners.get(RENDERER_DIAGNOSTIC_CHANNEL)!;
        const diagnostic = {
            kind: 'renderer-performance-scenario',
            diagnosticId: 'd66947a8-0da0-4a4b-8629-a7694116d8e5',
            scenarioId: '08f3dd5f-5c18-49e2-bc25-e46262ec624d',
            entry: 'workbench',
            action: 'session.switch',
            buildMode: 'profiling',
            durationMs: 750,
            documentVisible: true,
            documentFocused: false,
            visibilityInterrupted: false,
            focusInterrupted: false,
            capabilities: {
                longAnimationFrame: 'available',
                eventTiming: 'available',
                reactProfiler: 'available',
            },
            react: {
                commitCount: 3,
                profiledRenderCount: 5,
                mountRenderCount: 1,
                updateRenderCount: 3,
                nestedUpdateRenderCount: 1,
                actualDurationP50Ms: 12.5,
                actualDurationP95Ms: 24,
                actualDurationMaxMs: 24,
                baseDurationMaxMs: 41,
                surfaces: {
                    'primary-sidebar': {
                        profiledRenderCount: 1,
                        actualDurationP50Ms: 5,
                        actualDurationP95Ms: 5,
                        actualDurationMaxMs: 5,
                        actualDurationTotalMs: 5,
                        baseDurationMaxMs: 8,
                    },
                    'workbench': {
                        profiledRenderCount: 3,
                        actualDurationP50Ms: 12.5,
                        actualDurationP95Ms: 24,
                        actualDurationMaxMs: 24,
                        actualDurationTotalMs: 38,
                        baseDurationMaxMs: 41,
                    },
                    'secondary-sidebar': {
                        profiledRenderCount: 1,
                        actualDurationP50Ms: 7,
                        actualDurationP95Ms: 7,
                        actualDurationMaxMs: 7,
                        actualDurationTotalMs: 7,
                        baseDurationMaxMs: 10,
                    },
                },
            },
            requests: {
                sessionSelect: { count: 1, totalDurationMs: 18, maxDurationMs: 18 },
                appBootstrap: { count: 2, totalDurationMs: 24, maxDurationMs: 14 },
            },
            longAnimationFrames: {
                count: 2,
                totalDurationMs: 112,
                maxDurationMs: 64,
                totalBlockingDurationMs: 24,
                maxBlockingDurationMs: 16,
                maxStyleAndLayoutDurationMs: 8,
            },
            interactions: {
                count: 1,
                maxDurationMs: 48,
                maxInputDelayMs: 8,
                maxProcessingDurationMs: 24,
                maxPresentationDelayMs: 16,
            },
            frames: {
                sampleCount: 40,
                estimatedRefreshIntervalMs: 16.67,
                intervalP50Ms: 16.67,
                intervalP95Ms: 32,
                maxIntervalMs: 48,
                missedFrameCount: 3,
            },
            truncated: false,
        };

        report({ sender: {} }, diagnostic);
        expect(write).not.toHaveBeenCalled();
        report({ sender: renderer }, diagnostic);

        expect(write).toHaveBeenCalledOnce();
        expect(write).toHaveBeenCalledWith('info', 'renderer.performance_scenario', {
            durationMs: 750,
            correlationId: diagnostic.scenarioId,
            fields: {
                code: 'RENDERER_PERFORMANCE_SCENARIO',
                diagnosticId: diagnostic.diagnosticId,
                entry: 'workbench',
                action: 'session.switch',
                buildMode: 'profiling',
                documentVisible: true,
                documentFocused: false,
                visibilityInterrupted: false,
                focusInterrupted: false,
                longAnimationFrameCapability: 'available',
                eventTimingCapability: 'available',
                reactProfilerCapability: 'available',
                reactCommitCount: 3,
                reactProfiledRenderCount: 5,
                reactMountRenderCount: 1,
                reactUpdateRenderCount: 3,
                reactNestedUpdateRenderCount: 1,
                reactActualDurationP50Ms: 12.5,
                reactActualDurationP95Ms: 24,
                reactActualDurationMaxMs: 24,
                reactBaseDurationMaxMs: 41,
                reactPrimarySidebarRenderCount: 1,
                reactPrimarySidebarActualDurationP50Ms: 5,
                reactPrimarySidebarActualDurationP95Ms: 5,
                reactPrimarySidebarActualDurationMaxMs: 5,
                reactPrimarySidebarActualDurationTotalMs: 5,
                reactPrimarySidebarBaseDurationMaxMs: 8,
                reactWorkbenchRenderCount: 3,
                reactWorkbenchActualDurationP50Ms: 12.5,
                reactWorkbenchActualDurationP95Ms: 24,
                reactWorkbenchActualDurationMaxMs: 24,
                reactWorkbenchActualDurationTotalMs: 38,
                reactWorkbenchBaseDurationMaxMs: 41,
                reactSecondarySidebarRenderCount: 1,
                reactSecondarySidebarActualDurationP50Ms: 7,
                reactSecondarySidebarActualDurationP95Ms: 7,
                reactSecondarySidebarActualDurationMaxMs: 7,
                reactSecondarySidebarActualDurationTotalMs: 7,
                reactSecondarySidebarBaseDurationMaxMs: 10,
                sessionSelectRequestCount: 1,
                sessionSelectRequestTotalDurationMs: 18,
                sessionSelectRequestMaxDurationMs: 18,
                appBootstrapRequestCount: 2,
                appBootstrapRequestTotalDurationMs: 24,
                appBootstrapRequestMaxDurationMs: 14,
                longAnimationFrameCount: 2,
                longAnimationFrameTotalDurationMs: 112,
                longAnimationFrameMaxDurationMs: 64,
                longAnimationFrameTotalBlockingDurationMs: 24,
                longAnimationFrameMaxBlockingDurationMs: 16,
                longAnimationFrameMaxStyleAndLayoutDurationMs: 8,
                interactionCount: 1,
                interactionMaxDurationMs: 48,
                interactionMaxInputDelayMs: 8,
                interactionMaxProcessingDurationMs: 24,
                interactionMaxPresentationDelayMs: 16,
                frameSampleCount: 40,
                frameEstimatedRefreshIntervalMs: 16.67,
                frameIntervalP50Ms: 16.67,
                frameIntervalP95Ms: 32,
                frameMaxIntervalMs: 48,
                estimatedMissedFrameCount: 3,
                truncated: false,
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

    it('logs a caller-side NOT_FOUND request failure at warn with correlation and method', async () => {
        const write = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => false,
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
});
