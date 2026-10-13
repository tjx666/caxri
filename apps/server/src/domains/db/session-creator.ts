import { and, isNotNull, notInArray } from 'drizzle-orm';

import type { CaxriDatabaseConnection } from './database-connection';
import { sessions } from './schema';

/**
 * Clears `created_by_session_id` wherever the creating Session no longer exists. The column is not a foreign key (see
 * its schema comment), so every path that deletes Sessions calls this inside the same transaction; a dangling creator
 * would otherwise name a Session the sidebar can no longer show.
 */
export function clearDeletedSessionCreators(database: CaxriDatabaseConnection): void {
    const existingSessionIds = database.db.select({ id: sessions.id }).from(sessions);
    database.db
        .update(sessions)
        .set({ createdBySessionId: null })
        .where(
            and(
                isNotNull(sessions.createdBySessionId),
                notInArray(sessions.createdBySessionId, existingSessionIds),
            ),
        )
        .run();
}
