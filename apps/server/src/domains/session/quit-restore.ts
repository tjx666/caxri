import type { QuitStoppedSessions, SessionRestoreQuitStoppedResult } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { caxriBotIdentity } from '../db';

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
     * Relaunches the Session's stopped PTYs on their bound conversations and resumes its Chat; `shouldContinue` also
     * tells its primary Agent to continue.
     */
    resume(
        sessionId: string,
        stoppedTerminalIds: ReadonlySet<string>,
        shouldContinue: boolean,
    ): Promise<void>;
    logger: StructuredLogger;
    now?: () => number;
}

/**
 * Remembers what a quit's "Stop Tasks" ended and relaunches it on request (`session.restoreQuitStopped`). `stopped` is
 * final for every other path, so without this record the user has to find and restart each Session by hand. The record
 * is durable because it is only useful after the Server Core that wrote it exits. Caxri Bot is left out: it restores
 * through its own supervisor on the next start.
 */
export class QuitRestore {
    private isRestoring = false;

    constructor(private readonly options: QuitRestoreOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private writeRecord(): void {
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
                sessionCount: sessions.length,
                workingCount: sessions.filter(({ shouldContinue }) => shouldContinue).length,
            },
        });
        if (sessions.length === 0) return;
        database.setAppState('quitStoppedSessions', { stoppedAt: this.now(), sessions });
    }

    /**
     * Samples every Session with live work right before the quit's terminate stops it. A quit that stops nothing keeps
     * the previous record, so quitting again from an idle app does not lose what is still unrestored.
     */
    record(): void {
        try {
            this.writeRecord();
        } catch (error) {
            // The quit must still stop its tasks; only the restore offer is lost.
            this.options.logger.write('warn', logEventCatalog.sessionQuitRestore.recordFailed, {
                fields: { errorCode: isCaxriError(error) ? error.code : 'unknown' },
            });
        }
    }

    /**
     * Consumes the record first, so a second request (or one from another client) restores nothing twice. Sessions run
     * one at a time: the restore supervisor serves a single Session and aborts the previous one.
     */
    async restore(): Promise<SessionRestoreQuitStoppedResult> {
        if (this.isRestoring) return { restored: 0, skipped: 0 };
        const { database } = this.options;
        const stored = database.getAppState('quitStoppedSessions');
        if (!stored || stored.sessions.length === 0) return { restored: 0, skipped: 0 };
        this.isRestoring = true;
        const startedAt = this.now();
        database.setAppState('quitStoppedSessions', { ...stored, sessions: [] });
        let restored = 0;
        let continued = 0;
        let skipped = 0;
        try {
            for (const { sessionId, shouldContinue, terminalIds } of stored.sessions) {
                const session = database.getSession(sessionId);
                if (!session || session.archivedAt !== undefined) {
                    skipped += 1;
                    continue;
                }
                try {
                    // oxlint-disable-next-line react-doctor/async-await-in-loop
                    await this.options.resume(sessionId, new Set(terminalIds), shouldContinue); // eslint-disable-line no-await-in-loop -- see above
                    restored += 1;
                    if (shouldContinue) continued += 1;
                } catch {
                    // The Session keeps its stopped Terminals, which the user can still restart by hand.
                    skipped += 1;
                }
            }
        } finally {
            this.isRestoring = false;
            this.options.logger.write('info', logEventCatalog.sessionQuitRestore.restored, {
                fields: {
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
}
