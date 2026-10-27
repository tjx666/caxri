import { basename, join } from 'node:path';
import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { app, shell } from 'electron';

import { createAcceptanceUpdateFixture } from '../acceptance-update';
import { packagedSourceMapFlavor } from '../source-map-flavor';
import type { InPlaceInstallTarget } from './update-install';
import {
    collectInPlaceInstallReport,
    launchInPlaceInstall,
    resolveInPlaceInstallTarget,
    stageUpdateBundle,
} from './update-install';
import { recordLaunchVersion } from './update-launch-version';
import { UpdateService, updateStateLogFields } from './updates';

/**
 * Builds the app's update service: enabled only when packaged, downloading into the profile, logging every state but
 * download progress, and publishing each state to the Workbench as `updates.state`. On macOS it also stages each
 * verified release for the in-place install that `Restart to Update` and an ordinary quit perform.
 */
export function createDesktopUpdateService(options: {
    currentVersion: string;
    logger: () => StructuredLogger | undefined;
    restartToUpdate: () => Promise<void>;
    sendEvent: (event: ServerEvent) => void;
    userDataPath: string;
}): UpdateService {
    const { userDataPath } = options;
    const downloadDirectory = join(userDataPath, 'updates');
    const logInstall = (level: 'error' | 'info', fields: Record<string, number | string>) =>
        options.logger()?.write(level, logEventCatalog.updates.install, { fields });
    let installTarget: Promise<InPlaceInstallTarget> | undefined;
    const resolveTarget = () =>
        (installTarget ??= resolveInPlaceInstallTarget({
            executablePath: app.getPath('exe'),
            isPackaged: app.isPackaged,
            platform: process.platform,
        }));
    let stagedPath: string | undefined;
    /**
     * The version whose in-place install failed on the previous run. Offering the same restart again would fail the
     * same way, so that version installs from the DMG instead.
     */
    let failedInstallVersion: string | undefined;

    const service = new UpdateService({
        acceptanceDiscovery: createAcceptanceUpdateFixture({
            environment: process.env,
            isPackaged: app.isPackaged,
            userDataPath,
        }),
        currentVersion: options.currentVersion,
        downloadDirectory,
        enabled: app.isPackaged,
        openPath: (path) => shell.openPath(path),
        prepareInstall: async ({ dmgPath, version }) => {
            stagedPath = undefined;
            const target = await resolveTarget();
            if (version === failedInstallVersion || target.kind === 'unavailable') {
                logInstall('info', {
                    phase: 'stage',
                    outcome:
                        target.kind === 'unavailable' ? target.reason : 'previous-install-failed',
                    version,
                });
                return 'manual';
            }
            const startedAt = Date.now();
            try {
                stagedPath = await stageUpdateBundle({
                    bundlePath: target.bundlePath,
                    dmgPath,
                    stagingDirectory: join(downloadDirectory, 'staged'),
                    version,
                });
                logInstall('info', {
                    phase: 'stage',
                    outcome: 'staged',
                    version,
                    durationMs: Date.now() - startedAt,
                });
                return 'restart';
            } catch (error) {
                logInstall('error', {
                    phase: 'stage',
                    outcome: 'stage-failed',
                    version,
                    durationMs: Date.now() - startedAt,
                    error: error instanceof Error ? error.message : String(error),
                });
                return 'manual';
            }
        },
        launchInstall: async ({ relaunch, version }) => {
            const target = await resolveTarget();
            if (!stagedPath || target.kind === 'unavailable') return;
            logInstall('info', {
                phase: 'launch',
                outcome: relaunch ? 'restart' : 'quit',
                version,
            });
            await launchInPlaceInstall({
                bundlePath: target.bundlePath,
                fromVersion: options.currentVersion,
                pid: process.pid,
                relaunch,
                stagedPath,
                toVersion: version,
                updatesDirectory: downloadDirectory,
            });
        },
        restartToUpdate: options.restartToUpdate,
        sourceMapFlavor: packagedSourceMapFlavor(),
        onState: (state) => {
            if (state.status !== 'downloading')
                options
                    .logger()
                    ?.write(
                        state.status === 'error' ? 'error' : 'info',
                        logEventCatalog.updates.state,
                        { fields: updateStateLogFields(state) },
                    );
            options.sendEvent({ event: 'updates.state', payload: state });
        },
    });
    // Packaged only: an unpackaged checkout's version is whatever package.json says and would announce itself.
    if (app.isPackaged) {
        void recordLaunchVersion(userDataPath, options.currentVersion).then((updatedFrom) => {
            if (updatedFrom !== undefined) service.announceUpdatedFrom(updatedFrom);
        });
        void resolveTarget()
            .then((target) =>
                target.kind === 'available'
                    ? collectInPlaceInstallReport(downloadDirectory, basename(target.bundlePath))
                    : undefined,
            )
            .then((report) => {
                if (!report) return;
                if (report.outcome !== 'installed') failedInstallVersion = report.to;
                logInstall(report.outcome === 'installed' ? 'info' : 'error', {
                    phase: 'apply',
                    outcome: report.outcome,
                    from: report.from,
                    to: report.to,
                });
            });
    }
    return service;
}
