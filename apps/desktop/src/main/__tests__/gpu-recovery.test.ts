import { describe, expect, it, vi } from 'vitest';

import { createGpuRecoveryCoordinator } from '../gpu-recovery';

function createHarness() {
    const app = { on: vi.fn(), quit: vi.fn(), relaunch: vi.fn() };
    const diagnostics = {
        recordGpuProcessGone: vi.fn(() => ({
            contextLost: true,
            correlationId: 'gpu-incident-1',
        })),
    };
    const sendEvent = vi.fn();
    const updateArgvConfig = vi.fn(() =>
        Promise.resolve({ hardwareAcceleration: true, remoteDebugging: true }),
    );
    const coordinator = createGpuRecoveryCoordinator({
        app: app as never,
        boot: {
            argvConfig: { hardwareAcceleration: true, remoteDebugging: true },
        },
        diagnostics: diagnostics as never,
        isE2E: false,
        logger: () => {},
        prepareRelaunch: vi.fn(),
        sendEvent,
        updateArgvConfig,
    });
    return { app, coordinator, sendEvent, updateArgvConfig };
}

describe('GPU recovery coordinator', () => {
    it('never persists an automatic Safe Mode decision after repeated GPU incidents', () => {
        const harness = createHarness();

        harness.coordinator.recordProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });
        harness.coordinator.recordProcessGone({
            type: 'GPU',
            reason: 'abnormal-exit',
            exitCode: 8704,
        });

        expect(harness.updateArgvConfig).not.toHaveBeenCalled();
        expect(harness.sendEvent).toHaveBeenCalledTimes(2);
    });

    it('marks Safe Mode restart intent before Electron enters the ordinary quit path', async () => {
        const calls: string[] = [];
        const coordinator = createGpuRecoveryCoordinator({
            app: {
                on: vi.fn(),
                quit: vi.fn(() => calls.push('quit')),
                relaunch: vi.fn(() => calls.push('relaunch')),
            } as never,
            boot: {
                argvConfig: { hardwareAcceleration: true, remoteDebugging: true },
            },
            diagnostics: {} as never,
            isE2E: false,
            logger: () => {},
            prepareRelaunch: () => calls.push('prepare'),
            sendEvent: vi.fn(),
            updateArgvConfig: () => {
                calls.push('persist');
                return Promise.resolve({
                    hardwareAcceleration: false,
                    remoteDebugging: true,
                });
            },
        });

        await coordinator.mainMethodOptions.restartInGpuSafeMode();

        expect(calls).toEqual(['persist', 'prepare', 'relaunch', 'quit']);
    });
});
