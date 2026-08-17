import { errorMessage } from '../shared/ipc/errors';
import type { StructuredLogger } from '../shared/node/logger';
import type { FileService } from './files';

/**
 * Fire-and-forget wrappers for recoverable background work (file watching, interrupted-Terminal restore) that must
 * never delay the triggering IPC response. Kept out of `bootstrap.ts` to stay under the file's physical-line budget.
 */
export function createBackgroundTasks(
    logger: StructuredLogger,
    files: FileService,
    restoreInterruptedTerminals: (sessionId: string) => Promise<void>,
): {
    restoreInterruptedTerminalsInBackground: (sessionId: string) => void;
    watchSessionInBackground: (sessionId: string | undefined) => void;
} {
    /**
     * File watching is recoverable background work (`FileWatcherService#watchSession` already catches and logs its own
     * setup failures) and must never delay a Runtime IPC response, so every call site fires this without awaiting it.
     */
    function watchSessionInBackground(sessionId: string | undefined): void {
        // This helper is intentionally synchronous (`void` return) so sync IPC handlers such as
        // `project.delete` can call it without becoming `async`; it cannot `await` its own promise.
        // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget helper, see comment above
        files.watchSession(sessionId).catch((error: unknown) =>
            logger.write('error', 'files.watch_session_failed', {
                fields: { sessionId: sessionId ?? 'none', error: errorMessage(error, 'unknown') },
            }),
        );
    }

    /**
     * Restoring interrupted Terminals spawns PTYs and probes Agent CLIs; it must never delay the triggering IPC
     * response, so every call site fires this without awaiting it.
     */
    function restoreInterruptedTerminalsInBackground(sessionId: string): void {
        // Same fire-and-forget rationale as `watchSessionInBackground` above.
        // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget helper, see comment above
        restoreInterruptedTerminals(sessionId).catch((error: unknown) =>
            logger.write('error', 'terminal.restore_interrupted_failed', {
                fields: { sessionId, error: errorMessage(error, 'unknown') },
            }),
        );
    }

    return { restoreInterruptedTerminalsInBackground, watchSessionInBackground };
}
