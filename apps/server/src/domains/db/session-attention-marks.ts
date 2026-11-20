import type { SessionRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

/**
 * `session.markRead`: acknowledges the attention generation the Client showed, leaving it pending.
 */
function markAttentionRead(
    database: CaxriDatabaseConnection,
    sessionId: string,
    generation: number,
): { acknowledged: boolean; session: SessionRecord } {
    return database.transaction(() => {
        if (!database.sessions.get(sessionId))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        const isAcknowledged = database.sessions.acknowledgeAttention(sessionId, generation);
        return { acknowledged: isAcknowledged, session: database.sessions.get(sessionId)! };
    });
}

/**
 * `session.markDone`: resolves (and acknowledges) the attention generation the Client showed.
 */
function markAttentionDone(
    database: CaxriDatabaseConnection,
    sessionId: string,
    generation: number,
    now: number,
): { resolved: boolean; session: SessionRecord } {
    return database.transaction(() => {
        if (!database.sessions.get(sessionId))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        const isResolved = database.sessions.resolveAttention(sessionId, generation, now);
        return { resolved: isResolved, session: database.sessions.get(sessionId)! };
    });
}

/**
 * `session.markDoneMany` and the automatic Mark as Done sweep: resolves each entry's attention generation in one
 * transaction, with the same generation guard as {@link markAttentionDone}. A Session deleted or archived since the
 * caller listed it is skipped rather than failing the batch, so clearing a queue never stops at a row that left it.
 *
 * `resolvedAt` is what Idle ranks a resolved row by. The automatic sweep leaves it unset, like an Agent moving on by
 * itself, so a week-old Session it settles does not jump to the top of Idle as if the user had just ticked it.
 */
function markAttentionDoneMany(
    database: CaxriDatabaseConnection,
    entries: ReadonlyArray<{ sessionId: string; attentionGeneration: number }>,
    resolvedAt: number | undefined,
): string[] {
    return database.transaction(() => {
        const resolved: string[] = [];
        for (const { sessionId, attentionGeneration } of entries) {
            const session = database.sessions.get(sessionId);
            if (!session || session.archivedAt !== undefined) continue;
            if (database.sessions.resolveAttention(sessionId, attentionGeneration, resolvedAt))
                resolved.push(sessionId);
        }
        return resolved;
    });
}

type AttentionEntries = ReadonlyArray<{ sessionId: string; attentionGeneration: number }>;

/**
 * The user's (and the automatic sweep's) marks on Pending Attention, exposed as `CaxriDatabase.attentionMarks`.
 */
export class SessionAttentionMarks {
    constructor(private readonly database: CaxriDatabaseConnection) {}

    read(sessionId: string, generation: number) {
        return markAttentionRead(this.database, sessionId, generation);
    }

    done(sessionId: string, generation: number, now = Date.now()) {
        return markAttentionDone(this.database, sessionId, generation, now);
    }

    doneMany(entries: AttentionEntries, now = Date.now()): string[] {
        return markAttentionDoneMany(this.database, entries, now);
    }

    /**
     * The automatic Mark as Done sweep's resolve: the same generation guard as {@link doneMany}, but with no resolution
     * time, so Idle keeps ranking the Session by its last real activity.
     */
    settle(entries: AttentionEntries): string[] {
        return markAttentionDoneMany(this.database, entries, undefined);
    }
}
