import { basename, join } from 'node:path';
import process from 'node:process';

import type { ProjectTransferExportResult, ServerEvent } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { MessageBoxOptions } from 'electron';
import { app, BrowserWindow, dialog, shell } from 'electron';

import { createAcceptanceUpdateFixture } from '../acceptance-update';
import { translateMain } from '../locale';
import type { createMainQuitHandler, createQuitIntent } from '../main-quit-wiring';
import { exportProjectsAndSessions } from '../native-file-dialogs';
import type { DesktopServerConnection } from '../server-connection';
import { packagedSourceMapFlavor } from '../source-map-flavor';
import type { InPlaceInstallTarget } from './update-install';
import {
    collectInPlaceInstallReport,
    launchInPlaceInstall,
    resolveInPlaceInstallTarget,
    stagedUpdateResetReason,
    stageUpdateBundle,
} from './update-install';
import { recordLaunchVersion } from './update-launch-version';
import { updateStateLogFields } from './update-state-log';
import { UpdateService } from './updates';

const EXPORT_BUTTON = 0;
const UPDATE_BUTTON = 1;
const CANCEL_BUTTON = 2;

/**
 * Warns before restarting into an update that clears the Project and Session list, and offers the export that lets the
 * user bring them back. Exporting returns to the same prompt with the saved path, so the user still decides whether to
 * update; resolves `true` only for `Update Anyway`.
 */
export async function shouldInstallDataResettingUpdate(input: {
    exportProjects(): Promise<ProjectTransferExportResult | null>;
    showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
    version: string;
}): Promise<boolean> {
    let detail = translateMain('desktop.updateDataReset.detail');
    let isExported = false;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- one modal prompt at a time; each answer decides whether to ask again
        const { response } = await input.showMessageBox({
            type: 'warning',
            message: translateMain('desktop.updateDataReset.message', { version: input.version }),
            detail,
            buttons: [
                translateMain('desktop.updateDataReset.export'),
                translateMain('desktop.updateDataReset.update'),
                translateMain('desktop.updateDataReset.cancel'),
            ],
            defaultId: isExported ? UPDATE_BUTTON : EXPORT_BUTTON,
            cancelId: CANCEL_BUTTON,
        });
        if (response === UPDATE_BUTTON) return true;
        if (response !== EXPORT_BUTTON) return false;
        try {
            // eslint-disable-next-line no-await-in-loop -- the prompt reopens only after the export finished
            const result = await input.exportProjects();
            if (result) {
                isExported = true;
                detail = translateMain('desktop.updateDataReset.exported', { path: result.path });
            }
        } catch (error) {
            detail = translateMain('desktop.updateDataReset.exportFailed', {
                message: errorMessage(error, String(error)),
            });
        }
    }
}

/**
 * Builds the app's update service: enabled only when packaged, downloading into the profile, logging every state but
 * download progress, and publishing each state to the Workbench as `updates.state`. On macOS it also stages each
 * verified release for the in-place install that `Restart to Update` and an ordinary quit perform, and asks before
 * installing one that would clear the Project and Session list.
 */
export function createDesktopUpdateService(options: {
    currentVersion: string;
    logger: () => StructuredLogger | undefined;
    quitIntent: ReturnType<typeof createQuitIntent>;
    requestAppQuit: ReturnType<typeof createMainQuitHandler>;
    sendEvent: (event: ServerEvent) => void;
    /**
     * Read only once a data-resetting update is confirmed, long after Server Core attached.
     */
    server: () => Pick<DesktopServerConnection, 'request'>;
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
        confirmDataReset: (version) =>
            shouldInstallDataResettingUpdate({
                exportProjects: () =>
                    exportProjectsAndSessions({
                        dialog,
                        exportPath: (destination) =>
                            options.server().request('projectTransfer.exportPath', { destination }),
                        window: BrowserWindow.getFocusedWindow() ?? undefined,
                    }),
                showMessageBox: (box) => dialog.showMessageBox(box),
                version,
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
                return { installMode: 'manual' };
            }
            const startedAt = Date.now();
            try {
                stagedPath = await stageUpdateBundle({
                    bundlePath: target.bundlePath,
                    dmgPath,
                    stagingDirectory: join(downloadDirectory, 'staged'),
                    version,
                });
                const resetReason = await stagedUpdateResetReason({
                    bundlePath: target.bundlePath,
                    stagedPath,
                });
                logInstall('info', {
                    phase: 'stage',
                    outcome: resetReason ? 'staged-resets-data' : 'staged',
                    ...(resetReason && { resetReason }),
                    version,
                    durationMs: Date.now() - startedAt,
                });
                return resetReason
                    ? { installMode: 'restart', resetsData: true }
                    : { installMode: 'restart' };
            } catch (error) {
                logInstall('error', {
                    phase: 'stage',
                    outcome: 'stage-failed',
                    version,
                    durationMs: Date.now() - startedAt,
                    error: error instanceof Error ? error.message : String(error),
                });
                return { installMode: 'manual' };
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
        restartToUpdate: async () => {
            options.quitIntent.set('update');
            const outcome = await options.requestAppQuit(); // A pending ordinary quit may answer instead.
            if (outcome !== 'stopped' && options.quitIntent.current() === 'update')
                options.quitIntent.set('user');
        },
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
