import type { DelegationResultSource, SessionRelation } from '@caxri/protocol';
import { delegationResultSourceSchema, sessionRelationSchema } from '@caxri/protocol';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { sessionResults, sessions } from '../schema';

/**
 * The summary of the latest task a Session created for a delegation or a consult completed; see `sessionResults`.
 */
export interface SessionResult {
    sessionId: string;
    /**
     * The task that produced the summary. It may have been pruned from `agent_delegations` since.
     */
    delegationId: string;
    summary: string;
    source: DelegationResultSource;
    completedAt: number;
}

/**
 * A Session another Session created and how, as listed under that creator.
 */
export interface CreatedSession {
    sessionId: string;
    createdBySessionId: string;
    relation: SessionRelation;
    createdAt: number;
}

/**
 * Pure persistence for the Delegated Sessions feed: the result each delegated or consulted Session last produced, and
 * the Sessions a set of Sessions created (hand-offs included). The decisions (which task completing writes a result,
 * what the summary says) live in the delegation domain.
 */
export class CreatedSessionsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Stores the result, replacing the Session's earlier one.
     */
    saveResult(result: SessionResult): void {
        const { sessionId, source, ...rest } = result;
        const values = { ...rest, summarySource: source };
        this.database
            .insert(sessionResults)
            .values({ sessionId, ...values })
            .onConflictDoUpdate({ target: sessionResults.sessionId, set: values })
            .run();
    }

    /**
     * Removes the Session's stored result, if any.
     */
    deleteResult(sessionId: string): void {
        this.database.delete(sessionResults).where(eq(sessionResults.sessionId, sessionId)).run();
    }

    /**
     * The stored results of these Sessions, keyed by Session. A row whose source no longer parses (a build that wrote a
     * value this one does not know) is left out rather than failing the read.
     */
    results(sessionIds: readonly string[]): Map<string, SessionResult> {
        const results = new Map<string, SessionResult>();
        if (sessionIds.length === 0) return results;
        const rows = this.database
            .select()
            .from(sessionResults)
            .where(inArray(sessionResults.sessionId, [...sessionIds]))
            .all();
        for (const row of rows) {
            const source = delegationResultSourceSchema.safeParse(row.summarySource);
            if (source.success)
                results.set(row.sessionId, {
                    sessionId: row.sessionId,
                    delegationId: row.delegationId,
                    summary: row.summary,
                    source: source.data,
                    completedAt: row.completedAt,
                });
        }
        return results;
    }

    /**
     * The Sessions these Sessions created with a recorded relation, newest first and at most `limit`. A Session whose
     * creator was deleted has no creator to list under, so it never appears.
     */
    list(createdBySessionIds: readonly string[], limit: number): CreatedSession[] {
        if (createdBySessionIds.length === 0) return [];
        return this.database
            .select({
                sessionId: sessions.id,
                createdBySessionId: sessions.createdBySessionId,
                relation: sessions.createdByRelation,
                createdAt: sessions.createdAt,
            })
            .from(sessions)
            .where(
                and(
                    inArray(sessions.createdBySessionId, [...createdBySessionIds]),
                    isNotNull(sessions.createdByRelation),
                ),
            )
            .orderBy(desc(sessions.createdAt), desc(sessions.id))
            .limit(limit)
            .all()
            .flatMap((row) => {
                const relation = sessionRelationSchema.safeParse(row.relation);
                return row.createdBySessionId && relation.success
                    ? [
                          {
                              sessionId: row.sessionId,
                              createdBySessionId: row.createdBySessionId,
                              relation: relation.data,
                              createdAt: row.createdAt,
                          },
                      ]
                    : [];
            });
    }
}
