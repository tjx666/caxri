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
