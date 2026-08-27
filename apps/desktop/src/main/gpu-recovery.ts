import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { App } from 'electron';

import { readArgvConfigAtBoot } from './argv-config';
import type { createGpuDiagnostics, GpuProcessGoneDetails } from './gpu-diagnostics';
import type { createGpuSafeModeController, GpuSafeModeBootState } from './gpu-safe-mode';
import { readGpuSafeModeAtBoot } from './gpu-safe-mode';

export interface GpuBootState {
    argvConfig: ReturnType<typeof readArgvConfigAtBoot>;
    safeMode: GpuSafeModeBootState;
}

/**
 * Applies the Main-owned boot decision before Chromium starts.
 */
export function prepareGpuBoot(app: App, userDataPath: string): GpuBootState {
    const argvConfig = readArgvConfigAtBoot(userDataPath);
    const safeMode = readGpuSafeModeAtBoot(userDataPath);
    if (!argvConfig.hardwareAcceleration || safeMode.active) app.disableHardwareAcceleration();
    return { argvConfig, safeMode };
}

interface GpuRecoveryCoordinatorOptions {
    app: App;
    boot: GpuBootState;
    diagnostics: ReturnType<typeof createGpuDiagnostics>;
    isE2E: boolean;
    logger(): StructuredLogger | undefined;
    safeMode: ReturnType<typeof createGpuSafeModeController>;
    sendEvent(event: ServerEvent): void;
}

/**
 * Joins Electron's GPU lifecycle, the content-free incident receipt, Renderer recovery, and the next-launch circuit
 * breaker without granting the Renderer direct filesystem or process authority.
 */
export function createGpuRecoveryCoordinator(options: GpuRecoveryCoordinatorOptions) {
    let didSendBootStatus = false;
    let pendingDecision = Promise.resolve();

    async function persistDecision(correlationId: string): Promise<void> {
        const decision = await options.safeMode.recordContextLoss(correlationId);
        options.logger()?.write('warn', logEventCatalog.gpu.safeMode, {
            correlationId,
            fields: {
                code: 'GPU_SAFE_MODE_DECISION',
                active: decision.activated,
                newlyActivated: decision.newlyActivated,
                contextLossCount: decision.count,
            },
        });
    }

    function recordPersistenceFailure(correlationId: string, error: unknown): void {
        options.logger()?.write('error', logEventCatalog.gpu.safeMode, {
            correlationId,
            fields: {
                code: 'GPU_SAFE_MODE_PERSIST_FAILED',
                errorName: error instanceof Error && error.name ? error.name : 'UnknownError',
            },
        });
    }

    function recordProcessGone(details: GpuProcessGoneDetails) {
        const incident = options.diagnostics.recordGpuProcessGone(details);
        if (!incident?.contextLost) return incident;
        options.sendEvent({
            event: 'gpu.recoveryRequested',
            payload: { correlationId: incident.correlationId },
        });
        /**
         * Electron's event listener cannot await profile persistence. Keep one contained tail so a profile write
         * failure is logged without becoming an unhandled rejection, and shutdown can drain the serialized receipt.
         */
        pendingDecision = (async () => {
            try {
                await persistDecision(incident.correlationId);
            } catch (error) {
                recordPersistenceFailure(incident.correlationId, error);
            }
        })();
        return incident;
    }

    return {
        async drain(): Promise<void> {
            await pendingDecision;
            await options.safeMode.drain();
        },
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
                await options.safeMode.updateArgvConfig({ hardwareAcceleration: false });
                options.logger()?.write('info', logEventCatalog.gpu.safeMode, {
                    fields: { code: 'GPU_SAFE_MODE_RESTART', active: true, automatic: false },
                });
                options.app.relaunch();
                options.app.quit();
            },
            updateArgvConfig: options.safeMode.updateArgvConfig,
        },
        recordBoot(): void {
            options.logger()?.write('info', logEventCatalog.gpu.safeMode, {
                correlationId: options.boot.safeMode.correlationId,
                fields: {
                    code: 'GPU_SAFE_MODE_BOOT',
                    active:
                        !options.boot.argvConfig.hardwareAcceleration ||
                        options.boot.safeMode.active,
                    automatic: options.boot.safeMode.automatic,
                    hardwareAccelerationEnabled: options.app.isHardwareAccelerationEnabled(),
                },
            });
        },
        recordProcessGone,
        rendererReady(): void {
            if (didSendBootStatus || !options.boot.safeMode.active) return;
            didSendBootStatus = true;
            options.sendEvent({
                event: 'gpu.safeModeStatus',
                payload: {
                    active: true,
                    automatic: options.boot.safeMode.automatic,
                    ...(options.boot.safeMode.correlationId && {
                        correlationId: options.boot.safeMode.correlationId,
                    }),
                },
            });
        },
    };
}
