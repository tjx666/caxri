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
 * The Renderer performance receipt is the widest diagnostic branch, so its flat logging contract lives apart from the
 * sender-boundary suite in `workbench-ipc.test.ts`.
 */
describe('workbench IPC Renderer performance diagnostic', () => {
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
            renderer: () => renderer as never,
            transport: { dispatch: vi.fn(), negotiate: vi.fn() },
        });
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
            terminals: {
                attachedCount: 3,
                reusedCount: 2,
                stages: {
                    snapshotReplay: { count: 1, totalDurationMs: 9, maxDurationMs: 9 },
                    webglAttach: { count: 1, totalDurationMs: 6, maxDurationMs: 6 },
                    xtermCreate: { count: 1, totalDurationMs: 21, maxDurationMs: 21 },
                },
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
                terminalAttachedCount: 3,
                terminalReusedCount: 2,
                terminalSnapshotReplayCount: 1,
                terminalSnapshotReplayTotalDurationMs: 9,
                terminalSnapshotReplayMaxDurationMs: 9,
                terminalWebglAttachCount: 1,
                terminalWebglAttachTotalDurationMs: 6,
                terminalWebglAttachMaxDurationMs: 6,
                terminalXtermCreateCount: 1,
                terminalXtermCreateTotalDurationMs: 21,
                terminalXtermCreateMaxDurationMs: 21,
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
});
