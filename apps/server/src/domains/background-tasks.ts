import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { FileService } from './files';
import type { GitService } from './git';
import type { TerminalRestoreOptions } from './terminal';

async function updateWatch(
    files: FileService,
    git: GitService,
    logger: StructuredLogger,
    sessionId: string | undefined,
    shouldForce = false,
): Promise<void> {
    try {
        if (shouldForce && sessionId) await files.refreshWatchSession(sessionId);
        else await files.watchSession(sessionId);
        if (sessionId) await git.observeWatcherAttached(sessionId);
    } catch (error) {
        logger.write(
            'error',
            shouldForce
                ? logEventCatalog.files.refreshWatchSessionFailed
                : logEventCatalog.files.watchSessionFailed,
            {
                fields: { sessionId: sessionId ?? 'none', error: errorMessage(error, 'unknown') },
            },
        );
    }
}

/**
 * Rebinds a changed Workbench Root without delaying its synchronous selection event.
 */
export function refreshWatchSessionInBackground(
    files: FileService,
    git: GitService,
    logger: StructuredLogger,
    sessionId: string,
): void {
    // eslint-disable-next-line no-void -- root-change notification is synchronous; updateWatch owns error reporting
    void updateWatch(files, git, logger, sessionId, true);
}

/**
 * Fire-and-forget wrappers for recoverable background work (file watching, interrupted-Terminal restore) that must
 * never delay the triggering IPC response. This module owns that policy (never await, always log failures) so call
 * sites in the composition root cannot diverge from it.
 */
export function createBackgroundTasks(
    logger: StructuredLogger,
    files: FileService,
    git: GitService,
    restoreInterruptedTerminals: (
        sessionId: string,
        options?: TerminalRestoreOptions,
    ) => Promise<void>,
): {
    restoreInterruptedTerminalsInBackground: (
        sessionId: string,
        options?: TerminalRestoreOptions,
    ) => void;
    watchSessionInBackground: (sessionId: string | undefined) => void;
} {
    /**
     * File watching is recoverable background work (`FileWatcherService#watchSession` already catches and logs its own
     * setup failures) and must never delay a Server IPC response, so every call site fires this without awaiting it.
     */
    function watchSessionInBackground(sessionId: string | undefined): void {
        // eslint-disable-next-line no-void -- selection notification is synchronous; updateWatch owns error reporting
        void updateWatch(files, git, logger, sessionId);
    }

    /**
     * Restoring interrupted Terminals spawns PTYs and probes Agent CLIs; it must never delay the triggering IPC
     * response, so every call site fires this without awaiting it.
     */
    function restoreInterruptedTerminalsInBackground(
        sessionId: string,
        options?: TerminalRestoreOptions,
    ): void {
        // Same fire-and-forget rationale as `watchSessionInBackground` above.
        // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget helper, see comment above
        restoreInterruptedTerminals(sessionId, options).catch((error: unknown) =>
            logger.write('error', logEventCatalog.terminal.restoreInterruptedFailed, {
                fields: { sessionId, error: errorMessage(error, 'unknown') },
            }),
        );
    }

    return { restoreInterruptedTerminalsInBackground, watchSessionInBackground };
}
