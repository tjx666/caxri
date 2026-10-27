import type Database from 'better-sqlite3';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { CaxriDrizzleDatabase } from '../connection';
import * as schema from '../schema';
import { sessions } from '../schema';

/**
 * `sessions.last_viewed_at`: when the user last stopped looking at each Session in a focused, visible Desktop window.
 * Window presence writes it; Clients read it back as `SessionRecord.lastViewedAt`, the "since you last looked" boundary
 * a restarted Renderer starts from. It is deliberately neither the Session Activity clock nor `last_visited_at`:
 * looking is neither work nor a visit, and must not reorder the sidebar or republish the Session.
 */
export class SessionViewsModel {
    private readonly database: CaxriDrizzleDatabase;

    /**
     * Takes the Server's open SQLite handle; the migration runner has already added the column on it.
     */
    constructor(connection: Database.Database) {
        this.database = drizzle(connection, { schema });
    }

    /**
     * Records that the user stopped looking at `sessionId` at `at`. Only moves forward, so a late write for an earlier
     * leave never rewinds the boundary; a deleted Session changes nothing.
     */
    recordLeave(sessionId: string, at = Date.now()): boolean {
        const isEarlier = or(isNull(sessions.lastViewedAt), lt(sessions.lastViewedAt, at));
        return (
            this.database
                .update(sessions)
                .set({ lastViewedAt: at })
                .where(and(eq(sessions.id, sessionId), isEarlier))
                .run().changes === 1
        );
    }
}
