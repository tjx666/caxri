import { CAXRI_PROTOCOL_VERSION, errorMessage, isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerConnection } from '../server-connection';
import type { StartupFailureReason } from './startup-failure';
import {
    classifyStartupFailure,
    incompatibleServerChoice,
    incompatibleServerDialog,
    startupFailureChoice,
    startupFailureDialog,
} from './startup-failure';

interface ServerStartupDialog {
    showMessageBox(options: {
        buttons: string[];
        cancelId: number;
        defaultId: number;
        detail: string;
        message: string;
        title: string;
        type: 'error';
    }): Promise<{ response: number }>;
}

export interface ServerStartupOptions {
    dialog: ServerStartupDialog;
    /**
     * Directory that holds the diagnostic logs, revealed by "Reveal Logs in Finder".
     */
    logDirectory?: string;
    logger?: StructuredLogger;
    /**
     * Opens a folder in Finder; resolves to an error string or an empty string, like Electron's `shell.openPath`.
     */
    openPath?(path: string): Promise<string>;
    quit(): void;
    supervisor: Pick<DesktopServerConnection, 'start'>;
    /**
     * The profile data folder, revealed by "Reveal Data Folder".
     */
    userDataPath?: string;
}

function isIncompatibleServer(error: unknown): boolean {
    if (!isCaxriError(error) || error.code !== 'CONFLICT') return false;
    return (
        error.details?.clientProtocolVersion === CAXRI_PROTOCOL_VERSION &&
        typeof error.details.hostProtocolVersion === 'number' &&
        error.details.hostProtocolVersion !== CAXRI_PROTOCOL_VERSION
    );
}

async function reveal(options: ServerStartupOptions, path: string | undefined): Promise<void> {
    if (!path) return;
    try {
        await options.openPath?.(path);
    } catch {
        // Revealing is best effort; the dialog stays open either way.
    }
}

/**
 * Shows the "other build" dialog until the user quits; Reveal Data Folder keeps it open so they can still quit after.
 */
async function offerLocalReset(options: ServerStartupOptions): Promise<void> {
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- the dialog re-opens after Reveal until a final choice
            const { response } = await options.dialog.showMessageBox(incompatibleServerDialog());
            if (incompatibleServerChoice(response) !== 'reveal') return;
            // eslint-disable-next-line no-await-in-loop -- sequential with the dialog
            await reveal(options, options.userDataPath);
        }
    } finally {
        options.quit();
    }
}

/**
 * Starts one current-protocol Server attempt. A protocol mismatch explains the local reset and quits; any other failure
 * is shown with a closed reason and offers Try Again (re-runs the start), Reveal Logs in Finder, or Quit. Resolves
 * `false` when startup must not continue.
 */
export async function shouldContinueStartup(options: ServerStartupOptions): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
        const startedAt = performance.now();
        try {
            // eslint-disable-next-line no-await-in-loop -- Try Again retries strictly after the previous attempt
            await options.supervisor.start();
            options.logger?.write('info', logEventCatalog.serverConnection.attached, {
                durationMs: performance.now() - startedAt,
            });
            return true;
        } catch (error) {
            const isIncompatible = isIncompatibleServer(error);
            const reason = classifyStartupFailure(error);
            options.logger?.write('error', logEventCatalog.serverConnection.attachFailed, {
                durationMs: performance.now() - startedAt,
                fields: {
                    attempt,
                    error: errorMessage(error, 'unknown'),
                    reason: isIncompatible ? 'protocol-mismatch' : reason,
                },
            });
            if (isIncompatible) {
                // eslint-disable-next-line no-await-in-loop -- terminal branch
                await offerLocalReset(options);
                return false;
            }
            // eslint-disable-next-line no-await-in-loop -- terminal or retrying branch
            const choice = await askStartupRecovery(options, reason);
            if (choice === 'quit') {
                options.quit();
                return false;
            }
        }
    }
}

/**
 * Shows the start-failure dialog; Reveal Logs re-opens it, so only Try Again or Quit comes back.
 */
async function askStartupRecovery(
    options: ServerStartupOptions,
    reason: StartupFailureReason,
): Promise<'quit' | 'retry'> {
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- the dialog re-opens after Reveal until a final choice
        const { response } = await options.dialog.showMessageBox(startupFailureDialog(reason));
        const choice = startupFailureChoice(response);
        if (choice !== 'reveal') return choice;
        // eslint-disable-next-line no-await-in-loop -- sequential with the dialog
        await reveal(options, options.logDirectory);
    }
}
