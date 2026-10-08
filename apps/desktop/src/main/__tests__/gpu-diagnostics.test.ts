import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGpuDiagnostics } from '../gpu-diagnostics';

function rendererDiagnostic(
    overrides: Partial<
        Parameters<ReturnType<typeof createGpuDiagnostics>['recordRendererDiagnostic']>[0]
    > = {},
) {
    return {
        kind: 'terminal-renderer' as const,
        diagnosticId: 'renderer-diagnostic-1',
        terminalId: 'terminal-1',
        mode: 'webgl' as const,
        reason: 'active' as const,
        trigger: 'visibility-restore' as const,
        preference: 'auto' as const,
        contextLossCount: 0,
        redrawCount: 1,
        visibilityRestoreCoalescedCount: 0,
        liveWebglContextCount: 1,
        paneActive: true,
        terminalProcessRunning: true,
        agentTerminal: true,
        documentVisible: true,
        documentFocused: true,
        terminalFocused: true,
        recoveryResult: 'not-requested' as const,
        retryAttemptCount: 0,
        retryDelayMs: null,
        retryLimit: 3 as const,
        retryState: 'idle' as const,
        receivedBytes: 120,
        droppedBytes: 0,
        ...overrides,
    };
}

function createHarness(options: { createIncidentId?: () => string } = {}) {
    let now = 1_000;
    const write = vi.fn<StructuredLogger['write']>();
    const app = {
        commandLine: {
            getSwitchValue: vi.fn((name: string) => (name === 'use-angle' ? 'metal' : '')),
            hasSwitch: vi.fn((name: string) => name === 'enable-gpu-rasterization'),
        },
        getGPUFeatureStatus: vi.fn(() => ({
            '2d_canvas': 'enabled',
            'gpu_compositing': 'enabled',
            'rasterization': 'enabled',
            'skia_graphite': 'enabled_on',
            'webgl': 'enabled',
            'webgl2': 'enabled',
            'webgpu': 'enabled',
        })),
        getGPUInfo: vi.fn(() =>
            Promise.resolve({
                gpuDevice: [
                    {
                        active: true,
                        deviceId: 0,
                        vendorId: 0x106b,
                        vendorString: 'Apple',
                    },
                ],
                auxAttributes: {
                    displayType: 'ANGLE_METAL',
                    glImplementationParts: '(gl=egl-angle,angle=metal)',
                    glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max)',
                    skiaBackendType: 'GraphiteDawnMetal',
                },
                machineModelName: 'Mac',
                machineModelVersion: 'M5 Max',
            }),
        ),
        isHardwareAccelerationEnabled: vi.fn(() => true),
    };
    const diagnostics = createGpuDiagnostics({
        app,
        architecture: 'arm64',
        createIncidentId: options.createIncidentId ?? (() => 'gpu-incident-1'),
        logger: () => ({ write }) as never,
        now: () => now,
        osRelease: '25.5.0',
        platform: 'darwin',
        window: () => ({
            isFocused: () => true,
            isFullScreen: () => true,
            isMaximized: () => false,
            isMinimized: () => false,
            isSimpleFullScreen: () => false,
            isVisible: () => true,
        }),
    });
    return {
        app,
        diagnostics,
        setNow: (value: number) => {
            now = value;
        },
        write,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('GPU diagnostics', () => {
    it('stamps wake and GPU process exit timing onto a Terminal context loss', () => {
        vi.useFakeTimers();
        const harness = createHarness();
        const contextLoss = rendererDiagnostic({
            mode: 'dom',
            reason: 'context-loss',
            trigger: 'webgl-context-loss',
            contextLossCount: 1,
            liveWebglContextCount: 17,
        });
        const statusFields = () =>
            harness.write.mock.calls.findLast(
                ([, event]) => event === logEventCatalog.renderer.terminalRendererStatus,
            )?.[2]?.fields;

        // A cold loss with no wake and no GPU exit reads as null, never as zero elapsed time.
        harness.diagnostics.recordRendererDiagnostic(contextLoss);
        expect(statusFields()).toMatchObject({
            liveWebglContextCount: 17,
            msSinceSystemResume: null,
            msSinceScreenUnlock: null,
            systemResumeCount: 0,
            msSinceGpuProcessGone: null,
            gpuProcessGoneCount: 0,
        });

        harness.setNow(2_000);
        harness.diagnostics.recordSystemWake('resume');
        harness.setNow(2_500);
        harness.diagnostics.recordSystemWake('unlock-screen');
        harness.setNow(3_000);
        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });
        expect(
            harness.write.mock.calls.find(
                ([, event]) => event === logEventCatalog.gpu.processGone,
            )?.[2]?.fields,
        ).toMatchObject({
            msSinceSystemResume: 1_000,
            msSinceScreenUnlock: 500,
            systemResumeCount: 1,
            gpuProcessGoneCount: 1,
        });

        harness.setNow(6_000);
        harness.diagnostics.recordRendererDiagnostic(contextLoss);
        expect(statusFields()).toMatchObject({
            msSinceSystemResume: 4_000,
            msSinceScreenUnlock: 3_500,
            systemResumeCount: 1,
            msSinceGpuProcessGone: 3_000,
            gpuProcessGoneCount: 1,
        });
    });

    it('decodes POSIX Chromium GPU exits and links the last Renderer state', () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.diagnostics.recordRendererDiagnostic(rendererDiagnostic());
        harness.setNow(1_025);

        const incident = harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
            name: 'GPU Process',
        });

        expect(incident).toEqual({ contextLost: true, correlationId: 'gpu-incident-1' });
        const processGone = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.processGone,
        );
        expect(processGone?.[0]).toBe('error');
        expect(processGone?.[2]).toMatchObject({
            correlationId: 'gpu-incident-1',
            fields: {
                code: 'GPU_PROCESS_GONE',
                exitCode: 8704,
                chromiumResultCode: 34,
                chromiumResultName: 'RESULT_CODE_GPU_EXIT_ON_CONTEXT_LOST',
                contextLost: true,
                terminationKind: 'exit-code',
                posixSignal: null,
                coreDumped: false,
                relatedRendererDiagnosticId: 'renderer-diagnostic-1',
                relatedRendererAgeMs: 25,
                relatedRendererReason: 'active',
                relatedRendererTrigger: 'visibility-restore',
                relatedTerminalFocused: true,
                windowFullScreen: true,
                windowVisible: true,
            },
        });
    });

    it('aggregates every Renderer diagnostic inside the correlation window', () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({ diagnosticId: 'stale', trigger: 'webgl-retry-attempt' }),
        );
        harness.setNow(20_000);
        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({ diagnosticId: 'restore-1', terminalId: 'terminal-1' }),
        );
        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({ diagnosticId: 'restore-2', terminalId: 'terminal-2' }),
        );
        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({
                diagnosticId: 'retry-2',
                terminalId: 'terminal-2',
                mode: 'dom',
                reason: 'context-loss',
                trigger: 'webgl-retry-attempt',
            }),
        );
        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({
                diagnosticId: 'activate-3',
                terminalId: 'terminal-3',
                trigger: 'preference-change',
            }),
        );
        harness.setNow(20_010);

        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
            name: 'GPU Process',
        });

        const processGone = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.processGone,
        );
        expect(processGone?.[2]).toMatchObject({
            fields: {
                relatedRendererDiagnosticId: 'activate-3',
                relatedRendererDiagnosticCount: 4,
                relatedRendererTerminalCount: 3,
                relatedRendererWebglCreationCount: 2,
                relatedRendererVisibilityRestoreCount: 2,
            },
        });
    });

    it('reports zero related counts and no saturation when no Renderer diagnostic is in the window', () => {
        vi.useFakeTimers();
        const harness = createHarness();

        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'killed',
            exitCode: 15,
        });

        const processGone = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.processGone,
        );
        expect(processGone?.[2]).toMatchObject({
            fields: {
                relatedRendererDiagnosticCount: 0,
                relatedRendererTerminalCount: 0,
                relatedRendererWebglCreationCount: 0,
                relatedRendererVisibilityRestoreCount: 0,
                relatedRendererSaturation: 'none',
            },
        });
        expect(processGone?.[2]?.fields).not.toHaveProperty('relatedRendererDiagnosticId');
    });

    it('marks the related counts as saturated once the diagnostic buffer overflows inside the window', () => {
        vi.useFakeTimers();
        const harness = createHarness();
        // Three split panes restoring twice per Space switch overflow the 32-entry buffer within one window.
        for (let index = 0; index < 40; index += 1) {
            harness.setNow(1_000 + index * 100);
            harness.diagnostics.recordRendererDiagnostic(
                rendererDiagnostic({
                    diagnosticId: `restore-${index}`,
                    terminalId: `terminal-${index % 3}`,
                    trigger: index % 2 === 0 ? 'visibility-restore' : 'webgl-reprobe-succeeded',
                    visibilityRestoreCoalescedCount: index,
                }),
            );
        }
        harness.setNow(5_000);

        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });

        const processGone = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.processGone,
        );
        expect(processGone?.[2]).toMatchObject({
            fields: {
                relatedRendererDiagnosticCount: 32,
                relatedRendererTerminalCount: 3,
                relatedRendererWebglCreationCount: 16,
                relatedRendererVisibilityRestoreCount: 16,
                relatedRendererLifetimeVisibilityRestoreCoalescedCount: 39,
                relatedRendererSaturation: 'buffer-limit',
                relatedRendererDiagnosticId: 'restore-39',
            },
        });

        // Once the oldest retained entry ages out of the window the counts are exact again.
        harness.setNow(1_000 + 8 * 100 + 15_000 + 1);
        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });
        const later = harness.write.mock.calls.filter(
            ([, event]) => event === logEventCatalog.gpu.processGone,
        )[1];
        expect(later[2]).toMatchObject({
            fields: { relatedRendererDiagnosticCount: 31, relatedRendererSaturation: 'none' },
        });
    });

    it('keeps a buffer that filled up without evicting anything unsaturated', () => {
        vi.useFakeTimers();
        const harness = createHarness();
        for (let index = 0; index < 32; index += 1) {
            harness.setNow(1_000 + index * 100);
            harness.diagnostics.recordRendererDiagnostic(
                rendererDiagnostic({ diagnosticId: `restore-${index}` }),
            );
        }
        harness.setNow(5_000);
        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'crashed',
            exitCode: 1,
        });

        const processGone = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.processGone,
        );
        expect(processGone?.[2]).toMatchObject({
            fields: { relatedRendererDiagnosticCount: 32, relatedRendererSaturation: 'none' },
        });
    });

    it('does not label a POSIX signal as a Chromium result code', () => {
        vi.useFakeTimers();
        const harness = createHarness();

        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'killed',
            exitCode: 9,
        });

        const processGone = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.processGone,
        );
        expect(processGone?.[2]).toMatchObject({
            fields: {
                chromiumResultCode: null,
                chromiumResultName: null,
                contextLost: false,
                terminationKind: 'signal',
                posixSignal: 9,
                coreDumped: false,
            },
        });
    });

    it('correlates a later terminal fallback and captures the restarted GPU backend', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });
        harness.setNow(1_010);

        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({
                diagnosticId: 'renderer-diagnostic-2',
                mode: 'dom',
                reason: 'context-loss',
                trigger: 'webgl-context-loss',
                contextLossCount: 1,
                terminalFocused: false,
                correlationId: 'gpu-incident-1',
                recoveryResult: 'dom-restored',
            }),
        );
        await harness.diagnostics.handleGpuInfoUpdate();

        expect(harness.write).toHaveBeenCalledWith(
            'warn',
            logEventCatalog.renderer.terminalRendererStatus,
            expect.objectContaining({ correlationId: 'gpu-incident-1' }),
        );
        const recovery = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.recovery,
        );
        expect(recovery?.[0]).toBe('info');
        expect(recovery?.[2]).toMatchObject({
            correlationId: 'gpu-incident-1',
            fields: {
                receivedBytes: 120,
                droppedBytes: 0,
                recoveryResult: 'dom-restored',
                terminalProcessRunning: true,
            },
        });
        const snapshot = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.gpu.snapshot,
        );
        expect(snapshot?.[0]).toBe('info');
        expect(snapshot?.[2]).toMatchObject({
            correlationId: 'gpu-incident-1',
            fields: {
                scope: 'incident',
                gpuInfoUpdateObserved: true,
                hardwareAccelerationEnabled: true,
                featureSkiaGraphite: 'enabled_on',
                featureWebgl: 'enabled',
                featureWebgl2: 'enabled',
                glImplementation: '(gl=egl-angle,angle=metal)',
                glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max)',
                skiaBackendType: 'GraphiteDawnMetal',
                gpuVendorId: 0x106b,
                gpuDeviceId: 0,
                machineModelVersion: 'M5 Max',
                useAngle: 'metal',
                disableSkiaGraphite: false,
            },
        });
    });

    it('does not report a routine visibility redraw as an uncorrelated renderer failure', () => {
        const harness = createHarness();

        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({
                mode: 'dom',
                reason: 'context-loss',
                trigger: 'visibility-restore',
                contextLossCount: 1,
            }),
        );

        expect(harness.write).not.toHaveBeenCalled();
    });

    it('preserves an explicit GPU incident correlation for delayed WebGL retry diagnostics', () => {
        const harness = createHarness();
        harness.diagnostics.recordGpuProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });
        harness.setNow(61_000);

        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({
                correlationId: 'gpu-incident-1',
                contextLossCount: 1,
                diagnosticId: 'renderer-diagnostic-2',
                mode: 'webgl',
                reason: 'active',
                retryAttemptCount: 1,
                retryDelayMs: null,
                retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
                retryState: 'succeeded',
                trigger: 'webgl-retry-succeeded',
            }),
        );

        const retryStatus = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.renderer.terminalRendererStatus,
        );
        expect(retryStatus?.[0]).toBe('info');
        expect(retryStatus?.[2]).toMatchObject({
            correlationId: 'gpu-incident-1',
            fields: {
                retryAttemptCount: 1,
                retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
                retryState: 'succeeded',
            },
        });
        expect(harness.write).toHaveBeenCalledWith(
            'info',
            logEventCatalog.gpu.recovery,
            expect.objectContaining({ correlationId: 'gpu-incident-1' }),
        );
    });

    it('records an uncorrelated WebGL retry cancellation', () => {
        const harness = createHarness();

        harness.diagnostics.recordRendererDiagnostic(
            rendererDiagnostic({
                mode: 'dom',
                reason: 'context-loss',
                retryAttemptCount: 0,
                retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
                retryState: 'cancelled',
                trigger: 'webgl-retry-cancelled',
            }),
        );

        const retryStatus = harness.write.mock.calls.find(
            ([, event]) => event === logEventCatalog.renderer.terminalRendererStatus,
        );
        expect(retryStatus?.[0]).toBe('info');
        expect(retryStatus?.[2]).toMatchObject({
            fields: {
                retryState: 'cancelled',
                trigger: 'webgl-retry-cancelled',
            },
        });
    });

    it('bounds completed snapshot identities with the retained incident window', async () => {
        const incidentIds = Array.from({ length: 10 }, (_, index) => `gpu-incident-${index + 1}`);
        incidentIds.push('gpu-incident-1');
        const harness = createHarness({ createIncidentId: () => incidentIds.shift()! });

        async function captureIncidents(remaining: number): Promise<void> {
            if (remaining === 0) return;
            harness.diagnostics.recordGpuProcessGone({
                type: 'GPU',
                reason: 'abnormal-exit',
                exitCode: 8704,
            });
            await harness.diagnostics.handleGpuInfoUpdate();
            await captureIncidents(remaining - 1);
        }
        await captureIncidents(11);

        expect(harness.app.getGPUInfo).toHaveBeenCalledTimes(11);
    });
});
