import { and, eq, lt, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { sessions } from '../schema';

/**
 * Acknowledges only the generation the Renderer actually displayed.
 */
export function didAcknowledgeAttention(
    database: CaxriDrizzleDatabase,
    id: string,
    generation: number,
): boolean {
    return (
        database
            .update(sessions)
            .set({ acknowledgedAttentionGeneration: generation })
            .where(
                and(
                    eq(sessions.id, id),
                    eq(sessions.attentionGeneration, generation),
                    lt(sessions.acknowledgedAttentionGeneration, generation),
                ),
            )
            .run().changes === 1
    );
}

/**
 * Resolves exactly the generation the user acted on, and acknowledges it in the same write: marking a Session done also
 * means it has been seen. Independent of the read state, since the user usually reads a Session before resolving it. A
 * newer generation (a turn that ended after the Client rendered the row) does not match and stays pending; a repeated
 * click matches nothing and leaves `attentionResolvedAt` alone.
 *
 * `resolvedAt` is set only for an explicit mark-done, the one resolution that should lift the Session to the top of
 * Idle; a resolution by a new turn leaves the Session working instead.
 */
export function didResolveAttention(
    database: CaxriDrizzleDatabase,
    id: string,
    generation: number,
    resolvedAt?: number,
): boolean {
    return (
        database
            .update(sessions)
            .set({
                resolvedAttentionGeneration: generation,
                acknowledgedAttentionGeneration: sql`max(${sessions.acknowledgedAttentionGeneration}, ${generation})`,
                ...(resolvedAt !== undefined && { attentionResolvedAt: resolvedAt }),
            })
            .where(
                and(
                    eq(sessions.id, id),
                    eq(sessions.attentionGeneration, generation),
                    lt(sessions.resolvedAttentionGeneration, generation),
                ),
            )
            .run().changes === 1
    );
}
