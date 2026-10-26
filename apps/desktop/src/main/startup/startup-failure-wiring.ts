import type { StructuredLogger } from '@caxri/system';
import { app, dialog, Notification, shell } from 'electron';

import type { DesktopServerConnection } from '../server-connection';
import { createRuntimeFailurePrompt } from './runtime-failure';
import { shouldContinueStartup } from './server-startup';
import { announceServerReplacement } from './stale-server-notice';

interface StartupFailureWiringOptions {
    /**
     * Directory that holds the diagnostic logs (`DesktopProfile.logDirectory`), revealed by "Reveal Logs in Finder".
     */
    logDirectory: string;
    /**
     * Marks the coming quit as a relaunch before `app.relaunch()` runs.
     */
    prepareRelaunch(): void;
    /**
     * Reads the "System notifications" setting from Server Core.
     */
    readSystemNotificationsEnabled: () => Promise<boolean>;
    userDataPath: string;
}

/**
 * Wires the Electron-facing halves of Server failure handling for the composition root: the "Caxri stopped" dialog
 * after Server Core gives up restarting, the start-failure dialogs, and the notice after a stale Server was replaced.
 */
export function createStartupFailureWiring(options: StartupFailureWiringOptions) {
    function relaunch(): void {
        options.prepareRelaunch();
        app.relaunch();
        app.quit();
    }
    const runtimeFailurePrompt = createRuntimeFailurePrompt({
        quit: () => app.quit(),
        relaunch,
        revealLogs: () => {
            void shell.openPath(options.logDirectory);
        },
        showDialog: (dialogOptions) => dialog.showMessageBox(dialogOptions),
    });
    return {
        /**
         * Tells the user once the window is up that an upgrade replaced a stale Server and stopped its live Terminals.
         * Never rejects.
         */
        announceReplacement: async (supervisor: DesktopServerConnection): Promise<void> => {
            try {
                await announceServerReplacement(
                    supervisor.staleReplacement?.stoppedTerminals ?? 0,
                    {
                        isEnabled: options.readSystemNotificationsEnabled,
                        isSupported: () => Notification.isSupported(),
                        show: (notice) => new Notification(notice).show(),
                    },
                );
            } catch {
                // Best effort: callers fire this without awaiting, so a failed notice must not become an unhandled rejection.
            }
        },
        relaunch,
        runtimeFailurePrompt,
        /**
         * Starts Server Core, showing the failure dialogs; resolves `false` when startup must not continue.
         */
        startServer: (supervisor: DesktopServerConnection, logger: StructuredLogger) =>
            shouldContinueStartup({
                dialog,
                logDirectory: options.logDirectory,
                logger,
                openPath: (path) => shell.openPath(path),
                quit: () => app.quit(),
                supervisor,
                userDataPath: options.userDataPath,
            }),
    };
}
