import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { createGpuRecoveryCoordinator } from '../gpu-recovery';

function createHarness(recordContextLoss: (correlationId: string) => Promise<unknown>) {
    const app = { on: vi.fn(), quit: vi.fn(), relaunch: vi.fn() };
    const write = vi.fn<StructuredLogger['write']>();
    const diagnostics = {
        recordGpuProcessGone: vi.fn(() => ({
            contextLost: true,
            correlationId: 'gpu-incident-1',
        })),
    };
    const safeMode = {
        drain: vi.fn(() => Promise.resolve()),
        recordContextLoss: vi.fn(recordContextLoss),
        updateArgvConfig: vi.fn(),
    };
    const coordinator = createGpuRecoveryCoordinator({
        app: app as never,
        boot: {
            argvConfig: { hardwareAcceleration: true, remoteDebugging: true },
            safeMode: { active: false, automatic: false },
        },
        diagnostics: diagnostics as never,
        isE2E: false,
        logger: () => ({ write }) as never,
        prepareRelaunch: vi.fn(),
        safeMode: safeMode as never,
        sendEvent: vi.fn(),
    });
    return { app, coordinator, safeMode, write };
}

describe('GPU recovery coordinator', () => {
    it('contains and records a Safe Mode persistence failure', async () => {
        const harness = createHarness(() => Promise.reject(new TypeError('profile unavailable')));

        harness.coordinator.recordProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });

        await expect(harness.coordinator.drain()).resolves.toBeUndefined();
        expect(harness.write).toHaveBeenCalledWith(
            'error',
            logEventCatalog.gpu.safeMode,
            expect.objectContaining({
                correlationId: 'gpu-incident-1',
                fields: {
                    code: 'GPU_SAFE_MODE_PERSIST_FAILED',
                    errorName: 'TypeError',
                },
            }),
        );
    });

    it('drains the Main-owned Safe Mode queue before shutdown', async () => {
        const { promise: pending, resolve: finish } = Promise.withResolvers<void>();
        const harness = createHarness(() => pending);
        harness.coordinator.recordProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });

        const drained = harness.coordinator.drain();
        await Promise.resolve();
        expect(harness.safeMode.drain).not.toHaveBeenCalled();

        finish();
        await expect(drained).resolves.toBeUndefined();
        expect(harness.safeMode.drain).toHaveBeenCalledOnce();
    });

    it('marks Safe Mode restart intent before Electron enters the ordinary quit path', async () => {
        const calls: string[] = [];
        const harness = createHarness(() => Promise.resolve());
        const coordinator = createGpuRecoveryCoordinator({
            app: {
                on: vi.fn(),
                quit: vi.fn(() => calls.push('quit')),
                relaunch: vi.fn(() => calls.push('relaunch')),
            } as never,
            boot: {
                argvConfig: { hardwareAcceleration: true, remoteDebugging: true },
                safeMode: { active: false, automatic: false },
            },
            diagnostics: {} as never,
            isE2E: false,
            logger: () => {},
            prepareRelaunch: () => calls.push('prepare'),
            safeMode: harness.safeMode as never,
            sendEvent: vi.fn(),
        });

        await coordinator.mainMethodOptions.restartInGpuSafeMode();

        expect(calls).toEqual(['prepare', 'relaunch', 'quit']);
    });
});
