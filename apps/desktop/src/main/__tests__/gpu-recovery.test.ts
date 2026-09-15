import { describe, expect, it, vi } from 'vitest';

import { createGpuRecoveryCoordinator, resolveRenderingMode } from '../gpu-recovery';

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

    it('records the boot rendering state with the cause that produced it', () => {
        const records: Array<Record<string, unknown>> = [];
        function bootReason(input: {
            hardwareAcceleration: boolean;
            hardwareAccelerationEnabled: boolean;
        }): Record<string, unknown> | undefined {
            records.length = 0;
            createGpuRecoveryCoordinator({
                app: {
                    on: vi.fn(),
                    isHardwareAccelerationEnabled: () => input.hardwareAccelerationEnabled,
                    quit: vi.fn(),
                    relaunch: vi.fn(),
                } as never,
                boot: {
                    argvConfig: {
                        hardwareAcceleration: input.hardwareAcceleration,
                        remoteDebugging: true,
                    },
                },
                diagnostics: {} as never,
                isE2E: false,
                logger: () => ({
                    write: (_level: string, _event: unknown, entry: { fields: never }) =>
                        records.push(entry.fields),
                }),
                prepareRelaunch: vi.fn(),
                sendEvent: vi.fn(),
                updateArgvConfig: vi.fn(),
            } as never).recordBoot();
            return records[0];
        }

        expect(
            bootReason({ hardwareAcceleration: true, hardwareAccelerationEnabled: true }),
        ).toMatchObject({ active: false, reason: 'hardware-accelerated' });
        expect(
            bootReason({ hardwareAcceleration: false, hardwareAccelerationEnabled: false }),
        ).toMatchObject({ active: true, reason: 'user-preference' });
        // The population the old boolean hid: the user wants the GPU, the machine will not give it.
        expect(
            bootReason({ hardwareAcceleration: true, hardwareAccelerationEnabled: false }),
        ).toMatchObject({ active: true, reason: 'unavailable' });
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

describe('rendering mode', () => {
    it('names the user preference as the cause whenever the user turned acceleration off', () => {
        expect(
            resolveRenderingMode({
                hardwareAccelerationEnabled: false,
                hardwareAccelerationPreferred: false,
            }),
        ).toEqual({ reason: 'user-preference', softwareRendering: true });
    });

    it('separates a machine that cannot accelerate from a user who asked not to', () => {
        expect(
            resolveRenderingMode({
                hardwareAccelerationEnabled: false,
                hardwareAccelerationPreferred: true,
            }),
        ).toEqual({ reason: 'unavailable', softwareRendering: true });
    });

    it('reports no software rendering while the GPU is actually in use', () => {
        expect(
            resolveRenderingMode({
                hardwareAccelerationEnabled: true,
                hardwareAccelerationPreferred: true,
            }),
        ).toEqual({ reason: 'hardware-accelerated', softwareRendering: false });
    });
});
