import process from 'node:process';

import type { ArgvConfig, ArgvConfigChanges, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { App } from 'electron';

import { readArgvConfigAtBoot } from './argv-config';
import type { createGpuDiagnostics, GpuProcessGoneDetails } from './gpu-diagnostics';

export interface GpuBootState {
    argvConfig: ReturnType<typeof readArgvConfigAtBoot>;
}

/**
 * Applies the Main-owned boot decision before Chromium starts.
 */
export function prepareGpuBoot(app: App, userDataPath: string): GpuBootState {
    const argvConfig = readArgvConfigAtBoot(userDataPath);
    if (!argvConfig.hardwareAcceleration) app.disableHardwareAcceleration();
    return { argvConfig };
}

interface GpuRecoveryCoordinatorOptions {
    app: App;
    boot: GpuBootState;
    diagnostics: ReturnType<typeof createGpuDiagnostics>;
    isE2E: boolean;
    logger(): StructuredLogger | undefined;
    prepareRelaunch(): void;
    sendEvent(event: ServerEvent): void;
    updateArgvConfig(changes: ArgvConfigChanges): Promise<ArgvConfig>;
}

/**
 * Joins Electron's GPU lifecycle, the content-free incident receipt, and Renderer recovery without granting the
 * Renderer direct filesystem or process authority. GPU incidents never change the user's next-launch configuration.
 */
export function createGpuRecoveryCoordinator(options: GpuRecoveryCoordinatorOptions) {
    function recordProcessGone(details: GpuProcessGoneDetails) {
        const incident = options.diagnostics.recordGpuProcessGone(details);
        if (!incident?.contextLost) return incident;
        options.sendEvent({
            event: 'gpu.recoveryRequested',
            payload: { correlationId: incident.correlationId },
        });
        return incident;
    }

    return {
        install(): void {
            options.app.on('gpu-info-update', () => {
                // Electron emits this synchronously; snapshot failures are logged by the collector.
                // eslint-disable-next-line no-void -- asynchronous post-crash evidence collection
                void options.diagnostics.handleGpuInfoUpdate();
            });
            options.app.on('child-process-gone', (_event, details) => {
                if (details.reason === 'clean-exit') return;
                if (details.type === 'GPU') {
                    recordProcessGone(details);
                    return;
                }
                options.logger()?.write('error', logEventCatalog.app.childProcessGone, {
                    fields: {
                        code: 'CHILD_PROCESS_GONE',
                        type: details.type,
                        reason: details.reason,
                        exitCode: details.exitCode,
                        ...(details.name && { name: details.name }),
                    },
                });
            });
        },
        mainMethodOptions: {
            allowGpuTestInjection: options.isE2E,
            injectGpuContextLoss: () => {
                const incident = recordProcessGone({
                    type: 'GPU',
                    reason: 'abnormal-exit',
                    exitCode: process.platform === 'win32' ? 34 : 8704,
                    name: 'E2E GPU Process',
                });
                if (!incident) throw new Error('GPU context loss injection was not recorded');
                return { correlationId: incident.correlationId };
            },
            restartInGpuSafeMode: async () => {
                await options.updateArgvConfig({ hardwareAcceleration: false });
                options.logger()?.write('info', logEventCatalog.gpu.safeMode, {
                    fields: { code: 'GPU_SAFE_MODE_RESTART', active: true, automatic: false },
                });
                options.prepareRelaunch();
                options.app.relaunch();
                options.app.quit();
            },
            updateArgvConfig: (changes: ArgvConfigChanges) => options.updateArgvConfig(changes),
        },
        recordBoot(): void {
            options.logger()?.write('info', logEventCatalog.gpu.safeMode, {
                fields: {
                    code: 'GPU_SAFE_MODE_BOOT',
                    active: !options.boot.argvConfig.hardwareAcceleration,
                    automatic: false,
                    hardwareAccelerationEnabled: options.app.isHardwareAccelerationEnabled(),
                },
            });
        },
        recordProcessGone,
    };
}
