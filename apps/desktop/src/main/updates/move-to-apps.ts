import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { app, dialog } from 'electron';

import { translateMain } from '../locale';

interface MoveOfferInput {
    /**
     * Directory of the user's Downloads folder (`app.getPath('downloads')`), so an app left in the browser's download
     * location is recognized.
     */
    downloadsDirectory?: string;
    /**
     * `app.isInApplicationsFolder()`; macOS only.
     */
    isInApplicationsFolder: boolean;
    isPackaged: boolean;
    /**
     * Path of the running executable.
     */
    executablePath: string;
    platform: NodeJS.Platform;
}

/**
 * Whether Caxri should offer to move itself into Applications: a packaged macOS build that is not already there and
 * runs from a place a first-time user lands by accident: a mounted DMG volume (`/Volumes/...`), an App Translocation
 * sandbox (`/AppTranslocation/`, where Gatekeeper runs a quarantined app from a randomized read-only path), or the
 * Downloads folder. A user who keeps Caxri elsewhere on purpose (a local dev package, a custom folder) is not nagged.
 */
export function shouldOfferMoveToApps(input: MoveOfferInput): boolean {
    return (
        input.platform === 'darwin' &&
        input.isPackaged &&
        !input.isInApplicationsFolder &&
        launchLocationKind(input.executablePath, input.downloadsDirectory) !== 'other'
    );
}

/**
 * Names where the app is running from.
 */
export function launchLocationKind(
    executablePath: string,
    downloadsDirectory?: string,
): 'dmg' | 'downloads' | 'other' | 'translocated' {
    if (executablePath.includes('/AppTranslocation/')) return 'translocated';
    if (executablePath.startsWith('/Volumes/')) return 'dmg';
    if (
        downloadsDirectory &&
        executablePath.startsWith(`${downloadsDirectory.replace(/\/$/, '')}/`)
    )
        return 'downloads';
    return 'other';
}

const declinedFileName = 'move-to-applications.json';

/**
 * Whether the user already answered "Not Now" on this app version. Unreadable or malformed state counts as not
 * declined, so a damaged file can at worst repeat one prompt.
 */
async function wasDeclined(userDataPath: string, version: string): Promise<boolean> {
    try {
        const parsed: unknown = JSON.parse(
            await readFile(join(userDataPath, declinedFileName), 'utf8'),
        );
        return (
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { declinedVersion?: unknown }).declinedVersion === version
        );
    } catch {
        return false;
    }
}

async function rememberDeclined(userDataPath: string, version: string): Promise<void> {
    try {
        await writeFile(
            join(userDataPath, declinedFileName),
            JSON.stringify({ declinedVersion: version }),
        );
    } catch {
        // Best effort: failing to persist only means the prompt may repeat on the next launch.
    }
}

export interface MoveToAppsOptions {
    /**
     * Marks the coming quit as a relaunch (`quitIntent = 'relaunch'`) so `before-quit` does not show the running-work
     * quit prompt for the quit that `moveToApplicationsFolder()` performs.
     */
    prepareRelaunch(): void;
    /**
     * Puts the quit intent back after a move that did not quit the app.
     */
    restoreQuitIntent(): void;
    /**
     * Profile directory that holds the "Not Now" record.
     */
    userDataPath: string;
}

interface MoveToAppsDependencies {
    downloadsDirectory: string;
    executablePath: string;
    isE2E: boolean;
    isInApplicationsFolder: boolean;
    isPackaged: boolean;
    moveToApplicationsFolder(): boolean;
    platform: NodeJS.Platform;
    showPrompt(): Promise<number>;
    version: string;
}

const launchState = { isOffered: false };

/**
 * Asks at most once per launch, and at most once per app version after "Not Now", whether to move Caxri into
 * Applications, then lets Electron copy and relaunch it. Declining or a failed move leaves the running app untouched.
 */
export async function offerMoveToAppsWith(
    options: MoveToAppsOptions,
    dependencies: MoveToAppsDependencies,
): Promise<void> {
    if (launchState.isOffered || dependencies.isE2E) return;
    if (
        !shouldOfferMoveToApps({
            downloadsDirectory: dependencies.downloadsDirectory,
            executablePath: dependencies.executablePath,
            isInApplicationsFolder: dependencies.isInApplicationsFolder,
            isPackaged: dependencies.isPackaged,
            platform: dependencies.platform,
        })
    )
        return;
    launchState.isOffered = true;
    if (await wasDeclined(options.userDataPath, dependencies.version)) return;
    const response = await dependencies.showPrompt();
    if (response !== 0) {
        await rememberDeclined(options.userDataPath, dependencies.version);
        return;
    }
    // A successful move quits this process; without the relaunch intent, `before-quit` would ask about running work.
    options.prepareRelaunch();
    let isMoved = false;
    try {
        isMoved = dependencies.moveToApplicationsFolder();
    } catch {
        // Electron reports a failed or refused move by returning false or throwing; staying put is the safe outcome.
    }
    if (!isMoved) options.restoreQuitIntent();
}

export function offerMoveToApps(options: MoveToAppsOptions): Promise<void> {
    return offerMoveToAppsWith(options, {
        downloadsDirectory: app.getPath('downloads'),
        executablePath: process.execPath,
        isE2E: process.env.CAXRI_E2E === '1',
        isInApplicationsFolder: process.platform === 'darwin' && app.isInApplicationsFolder(),
        isPackaged: app.isPackaged,
        moveToApplicationsFolder: () => app.moveToApplicationsFolder(),
        platform: process.platform,
        showPrompt: async () =>
            (
                await dialog.showMessageBox({
                    type: 'question',
                    message: translateMain('desktop.moveToApplications.message'),
                    detail: translateMain('desktop.moveToApplications.detail'),
                    buttons: [
                        translateMain('desktop.moveToApplications.move'),
                        translateMain('desktop.moveToApplications.notNow'),
                    ],
                    defaultId: 0,
                    cancelId: 1,
                })
            ).response,
        version: app.getVersion(),
    });
}
