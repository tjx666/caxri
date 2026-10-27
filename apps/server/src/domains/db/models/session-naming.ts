import { and, eq } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { sessions } from '../schema';

export function readAutomaticNaming(database: CaxriDrizzleDatabase, id: string) {
    return (
        database
            .select({ value: sessions.automaticNaming })
            .from(sessions)
            .where(eq(sessions.id, id))
            .get()?.value ?? undefined
    );
}

/**
 * Stores only synchronization intent, never source messages; manual ownership is an atomic write fence.
 */
export function didWriteAutomaticNaming(
    database: CaxriDrizzleDatabase,
    id: string,
    value: NonNullable<typeof sessions.$inferSelect.automaticNaming>,
    title?: string,
): boolean {
    return (
        database
            .update(sessions)
            .set({ automaticNaming: value, ...(title !== undefined && { title }) })
            .where(and(eq(sessions.id, id), eq(sessions.titleMode, 'automatic')))
            .run().changes === 1
    );
}
