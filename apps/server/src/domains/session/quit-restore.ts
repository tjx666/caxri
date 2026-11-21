import type { QuitStoppedSessions, SessionRestoreQuitStoppedResult } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { caxriBotIdentity } from '../db';

/**
 * How long after Restart to Update the next Server Core start still restores the stopped work on its own. The restart
 * is immediate, so an older record means the relaunch did not happen (a failed install, a Mac that shut down): Agents
 * told to continue that late would pick up work the user may have moved on from, so the launch notice offers it
 * instead.
 */
export const QUIT_RESTORE_AUTO_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * What stopped the recorded work: a quit's "Quit and Stop Tasks" or Restart to Update. It picks the continue prompt a
 * working Agent receives.
 */
export type QuitRestoreCause = 'quit' | 'update';

export interface QuitRestoreOptions {
    database: Pick<CaxriDatabase, 'getAppState' | 'getSession' | 'listTerminals' | 'setAppState'> &
        Parameters<typeof caxriBotIdentity>[0];
    /**
     * The Session's PTYs that still have a process, the ones a terminate is about to stop.
     */
    livePtyIds(sessionId: string): string[];
    hasLiveChat(sessionId: string): boolean;
    /**
     * Whether the Session's Agent is still working, the same test Airplane Mode samples on entry.
     */
    isWorking(sessionId: string): boolean;
    /**
     * Relaunches the Session's stopped PTYs on their bound conversations and resumes its Chat; `continueAfter` also
     * tells its primary Agent to continue, saying what stopped it.
     */
    resume(
        sessionId: string,
        stoppedTerminalIds: ReadonlySet<string>,
        continueAfter: QuitRestoreCause | undefined,
    ): Promise<void>;
    logger: StructuredLogger;
    now?: () => number;
}

/**
 * Remembers what a quit's "Stop Tasks" or Restart to Update ended and relaunches it: on request
 * (`session.restoreQuitStopped`), or on its own at the next start after an update. `stopped` is final for every other
 * path, so without this record the user has to find and restart each Session by hand. The record is durable because it
 * is only useful after the Server Core that wrote it exits. Caxri Bot is left out: it restores through its own
 * supervisor on the next start.
 */
export class QuitRestore {
    private isRestoring = false;

    constructor(private readonly options: QuitRestoreOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private logAutoRestoreFailed(error: unknown): void {
        this.options.logger.write('warn', logEventCatalog.sessionQuitRestore.autoRestoreFailed, {
            fields: { errorCode: isCaxriError(error) ? error.code : 'unknown' },
        });
    }

    private writeRecord(cause: QuitRestoreCause): void {
        const { database } = this.options;
        const botSessionId = caxriBotIdentity(database)?.sessionId;
        const sessionIds = new Set(database.listTerminals().map(({ sessionId }) => sessionId));
        const sessions: QuitStoppedSessions['sessions'] = [];
        for (const sessionId of sessionIds) {
            if (sessionId === botSessionId) continue;
            const terminalIds = this.options.livePtyIds(sessionId);
            if (terminalIds.length === 0 && !this.options.hasLiveChat(sessionId)) continue;
            sessions.push({
                sessionId,
                terminalIds,
                shouldContinue: this.options.isWorking(sessionId),
            });
        }
        this.options.logger.write('info', logEventCatalog.sessionQuitRestore.recorded, {
            fields: {
                cause,
                sessionCount: sessions.length,
                workingCount: sessions.filter(({ shouldContinue }) => shouldContinue).length,
            },
        });
        if (sessions.length === 0) return;
        database.setAppState('quitStoppedSessions', {
            stoppedAt: this.now(),
            ...(cause === 'update' && { restartedForUpdate: true as const }),
            sessions,
        });
    }

    /**
     * Takes the record for one restore, or `undefined` when another restore runs or nothing is recorded. It is consumed
     * synchronously, so a second request (or one from another client) restores nothing twice.
     */
    private claim(): QuitStoppedSessions | undefined {
        if (this.isRestoring) return undefined;
        const { database } = this.options;
        const stored = database.getAppState('quitStoppedSessions');
        if (!stored || stored.sessions.length === 0) return undefined;
        database.setAppState('quitStoppedSessions', { ...stored, sessions: [] });
        this.isRestoring = true;
        return stored;
    }

    /**
     * Sessions run one at a time: the restore supervisor serves a single Session and aborts the previous one.
     */
    private async run(
        stored: QuitStoppedSessions,
        automatic?: { beforeFirst(): Promise<void> },
    ): Promise<SessionRestoreQuitStoppedResult> {
        const { database } = this.options;
        const cause: QuitRestoreCause = stored.restartedForUpdate ? 'update' : 'quit';
        const startedAt = this.now();
        let restored = 0;
        let continued = 0;
        let skipped = 0;
        const failed: QuitStoppedSessions['sessions'] = [];
        try {
            await automatic?.beforeFirst();
            for (const entry of stored.sessions) {
                const { sessionId, shouldContinue, terminalIds } = entry;
                const session = database.getSession(sessionId);
                if (!session || session.archivedAt !== undefined) {
                    skipped += 1;
                    continue;
                }
                try {
                    const continueAfter = shouldContinue ? cause : undefined;
                    // oxlint-disable-next-line react-doctor/async-await-in-loop
                    await this.options.resume(sessionId, new Set(terminalIds), continueAfter); // eslint-disable-line no-await-in-loop -- see above
                    restored += 1;
                    if (shouldContinue) continued += 1;
                } catch {
                    // The Session keeps its stopped Terminals, which the user can still restart by hand.
                    skipped += 1;
                    failed.push(entry);
                }
            }
        } finally {
            this.isRestoring = false;
            // Nobody asked for an automatic restore, so nothing else would tell the user a relaunch failed: the launch
            // notice offers those Sessions instead.
            if (automatic && failed.length > 0)
                database.setAppState('quitStoppedSessions', {
                    stoppedAt: stored.stoppedAt,
                    sessions: failed,
                });
            this.options.logger.write('info', logEventCatalog.sessionQuitRestore.restored, {
                fields: {
                    cause,
                    continued,
                    durationMs: this.now() - startedAt,
                    recordAgeMs: startedAt - stored.stoppedAt,
                    restored,
                    skipped,
                },
            });
        }
        return { restored, skipped };
    }

    /**
     * Server Core discards this promise, so it never rejects.
     */
    private async runAutomatically(
        claimed: QuitStoppedSessions,
    ): Promise<SessionRestoreQuitStoppedResult> {
        try {
            return await this.run(claimed, {
                beforeFirst: () => new Promise((resolve) => setImmediate(resolve)),
            });
        } catch (error) {
            this.logAutoRestoreFailed(error);
            return { restored: 0, skipped: claimed.sessions.length };
        }
    }

    /**
     * Samples every Session with live work right before the quit's terminate stops it. A quit that stops nothing keeps
     * the previous record, so quitting again from an idle app does not lose what is still unrestored. `update` marks
     * the record for {@link restoreAfterUpdate}.
     */
    record(cause: QuitRestoreCause = 'quit'): void {
        try {
            this.writeRecord(cause);
        } catch (error) {
            // The quit must still stop its tasks; only the restore offer is lost.
            this.options.logger.write('warn', logEventCatalog.sessionQuitRestore.recordFailed, {
                fields: { errorCode: isCaxriError(error) ? error.code : 'unknown' },
            });
        }
    }

    /**
     * How many recorded Sessions a restore would still relaunch, and when the quit stopped them, read without consuming
     * the record so a launch can offer it. Sessions deleted or archived since the quit are left out, since a restore
     * would only skip them.
     */
    pending(): { count: number; stoppedAt?: number } {
        if (this.isRestoring) return { count: 0 };
        const { database } = this.options;
        const stored = database.getAppState('quitStoppedSessions');
        if (!stored || stored.sessions.length === 0) return { count: 0 };
        const count = stored.sessions.filter(({ sessionId }) => {
            const session = database.getSession(sessionId);
            return session !== undefined && session.archivedAt === undefined;
        }).length;
        this.options.logger.write('info', logEventCatalog.sessionQuitRestore.offered, {
            fields: {
                count,
                recordAgeMs: this.now() - stored.stoppedAt,
                recordedCount: stored.sessions.length,
            },
        });
        return { count, stoppedAt: stored.stoppedAt };
    }

    /**
     * Relaunches what the last quit stopped, on request (`session.restoreQuitStopped`).
     */
    async restore(): Promise<SessionRestoreQuitStoppedResult> {
        const stored = this.claim();
        return stored ? this.run(stored) : { restored: 0, skipped: 0 };
    }

    /**
     * Server Core start: restores on its own what Restart to Update stopped moments ago, so running work carries on in
     * the new version without the user asking (issue #4075). A record older than {@link QUIT_RESTORE_AUTO_MAX_AGE_MS},
     * or one a plain quit wrote, stays for the launch notice. The record is claimed before this returns, so a Client's
     * first `session.quitStoppedCount` cannot offer it too; the relaunches wait one macrotask, until the rest of Server
     * Core's start has run.
     */
    restoreAfterUpdate(): Promise<SessionRestoreQuitStoppedResult> | undefined {
        let claimed: QuitStoppedSessions | undefined;
        try {
            const stored = this.options.database.getAppState('quitStoppedSessions');
            if (
                !stored?.restartedForUpdate ||
                this.now() - stored.stoppedAt > QUIT_RESTORE_AUTO_MAX_AGE_MS
            )
                return undefined;
            claimed = this.claim();
        } catch (error) {
            // This runs inside Server Core's start, which must not fail over a restore nobody asked for.
            this.logAutoRestoreFailed(error);
            return undefined;
        }
        if (!claimed) return undefined;
        return this.runAutomatically(claimed);
    }
}
