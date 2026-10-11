import process from 'node:process';

import type { ArgvConfig, ArgvConfigChanges, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { App } from 'electron';
import { powerMonitor } from 'electron';

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

/**
 * Why this launch is drawing the way it is. A closed enum rather than a boolean, because "acceleration is off" recorded
 * without its cause cannot tell a deliberate user preference apart from a machine Chromium refused to accelerate, and
 * those two need opposite follow-ups.
 */
type RenderingModeReason = 'hardware-accelerated' | 'unavailable' | 'user-preference';

export interface RenderingMode {
    reason: RenderingModeReason;
    /**
     * True whenever Caxri is drawing without the GPU, whichever of the two causes put it there. This is the state every
     * user-facing surface calls "software rendering"; `hardwareAcceleration` is the name of the setting, never of the
     * state. Keeping the two words apart is the whole point of resolving this here instead of at each call site.
     */
    softwareRendering: boolean;
}

/**
 * The single answer to "is Caxri drawing with the GPU right now, and why not". The user's persisted preference wins the
 * naming when it is off, because that is the one cause a user can undo; a machine that simply cannot accelerate reports
 * `unavailable` so a log reader is not told the user chose it.
 */
export function resolveRenderingMode(input: {
    hardwareAccelerationEnabled: boolean;
    hardwareAccelerationPreferred: boolean;
}): RenderingMode {
    if (!input.hardwareAccelerationPreferred)
        return { reason: 'user-preference', softwareRendering: true };
    if (!input.hardwareAccelerationEnabled)
        return { reason: 'unavailable', softwareRendering: true };
    return { reason: 'hardware-accelerated', softwareRendering: false };
}

interface GpuRecoveryCoordinatorOptions {
    app: App;
    boot: GpuBootState;
    diagnostics: ReturnType<typeof createGpuDiagnostics>;
    isE2E: boolean;
    /**
     * True once a quit was accepted. A signal-driven quit (SIGTERM to the whole process group) takes the GPU and
     * utility processes down with it; production logged that as error-level crashes and requested GPU recovery for an
     * app that was exiting.
     */
    isQuitting?(): boolean;
    logger(): StructuredLogger | undefined;
    prepareRelaunch(): void;
    sendEvent(event: ServerEvent): void;
    updateArgvConfig(changes: ArgvConfigChanges): Promise<ArgvConfig>;
}

/**
 * Joins Electron's GPU lifecycle, the content-free incident receipt, and Renderer recovery without granting the
 * Renderer direct filesystem or process authority.
 *
 * A GPU incident never changes the user's next-launch configuration by itself: the only write lives behind
 * `restartInGpuSafeMode`, which the Renderer calls only after the user answered the shared confirmation modal (see
 * `features/gpu/gpu-commands.ts`). VS Code does not offer this action at all: a GPU crash there is telemetry only, and
 * `disable-hardware-acceleration` has no write site in the whole product. Caxri keeps the one-click escape because a
 * Terminal workbench that cannot draw is unusable, so the confirmation is what stops one click on a crash card from
 * silently costing every future launch its GPU.
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
            // `powerMonitor` is unusable before `ready`. A wake is recorded, not acted on: it only explains a later
            // Terminal context loss or GPU process exit that `gpu-diagnostics.ts` stamps with the elapsed time.
            options.app.on('ready', () => {
                powerMonitor.on('resume', () => options.diagnostics.recordSystemWake('resume'));
                powerMonitor.on('unlock-screen', () =>
                    options.diagnostics.recordSystemWake('unlock-screen'),
                );
            });
            options.app.on('child-process-gone', (_event, details) => {
                if (details.reason === 'clean-exit') return;
                if (options.isQuitting?.()) {
                    options.logger()?.write('info', logEventCatalog.app.childProcessGone, {
                        fields: {
                            code: 'CHILD_PROCESS_GONE',
                            type: details.type,
                            reason: details.reason,
                            exitCode: details.exitCode,
                            source: 'app-quitting',
                        },
                    });
                    return;
                }
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
            /**
             * Persist first, relaunch second: a failed write rejects before anything restarts, so the user never loses
             * the running window to a change that did not land. This mirrors VS Code's one comparable boot-flag gate
             * (`localeService.ts`: confirm, write `argv.json`, then restart).
             */
            restartInGpuSafeMode: async () => {
                await options.updateArgvConfig({ hardwareAcceleration: false });
                options.logger()?.write('info', logEventCatalog.gpu.safeMode, {
                    fields: {
                        code: 'GPU_SAFE_MODE_RESTART',
                        active: true,
                        automatic: false,
                        reason: 'user-preference',
                    },
                });
                options.prepareRelaunch();
                options.app.relaunch();
                options.app.quit();
            },
            updateArgvConfig: (changes: ArgvConfigChanges) => options.updateArgvConfig(changes),
        },
        /**
         * The launch's own rendering state, recorded with its cause. `active` deliberately follows the resolved state
         * rather than the persisted preference alone: a machine Chromium refuses to accelerate draws exactly like a
         * user who turned acceleration off, and a boot record that only echoed the setting would leave that population
         * invisible.
         */
        recordBoot(): void {
            const hardwareAccelerationEnabled = options.app.isHardwareAccelerationEnabled();
            const mode = resolveRenderingMode({
                hardwareAccelerationEnabled,
                hardwareAccelerationPreferred: options.boot.argvConfig.hardwareAcceleration,
            });
            options.logger()?.write('info', logEventCatalog.gpu.safeMode, {
                fields: {
                    code: 'GPU_SAFE_MODE_BOOT',
                    active: mode.softwareRendering,
                    automatic: false,
                    hardwareAccelerationEnabled,
                    reason: mode.reason,
                },
            });
        },
        recordProcessGone,
    };
}
