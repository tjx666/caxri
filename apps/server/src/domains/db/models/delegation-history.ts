import type { SessionRelation } from '@caxri/protocol';
import type { SQL } from 'drizzle-orm';
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { CaxriDrizzleDatabase } from '../connection';
import { delegationEdges, delegationHistory } from '../schema';

export type DelegationHistoryRow = typeof delegationHistory.$inferSelect;
export type DelegationHistoryInsert = typeof delegationHistory.$inferInsert;

/**
 * Sessions per `IN (...)` list, so one query stays far below SQLite's bound-parameter limit.
 */
const EDGE_QUERY_CHUNK = 500;

/**
 * Which rows a reader may see. `owner` reads every task. `caller` is an Agent or delegation client: the rows its exact
 * Terminal created under its exact principal (`principalHash`), or, with `anyPrincipal` (the Caxri Bot exception),
 * under any principal of that Terminal. The Terminal compare is NULL-safe: a delegation client has no Terminal.
 */
export type DelegationHistoryScope =
    | { kind: 'owner' }
    | {
          kind: 'caller';
          terminalId: string | undefined;
          principalHash: string;
          anyPrincipal: boolean;
      };

export interface DelegationHistoryPageQuery {
    scope: DelegationHistoryScope;
    /**
     * A ready `LIKE` pattern (see `likeSubstringPattern`) matched against title and summary.
     */
    pattern?: string;
    outcome?: DelegationHistoryRow['outcome'];
    /**
     * Rows to return; the model reads one more to learn whether another page exists.
     */
    limit: number;
    after?: { createdAt: number; delegationId: string };
}

export interface DelegationEdge {
    sessionId: string;
    parentSessionId: string;
    relation: SessionRelation;
}

/**
 * Pure persistence for delegation history and the provenance edges the cost roll-up walks; see `delegationHistory` and
 * `delegationEdges`. The decisions (what a settle writes, who may read a row) live in the delegation domain.
 */
export class DelegationHistoryModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Writes the settle of one task. A first write inserts every column. A replay or a re-settle (a completed task
     * later marked human-intervened) leaves the provenance columns alone, takes the new outcome, failure, and time,
     * keeps a counter the new write does not know, and replaces the summary pair outright (never merging an old summary
     * into a new outcome). A compacted row keeps its text cleared. Returns whether the row is new.
     */
    private upsert(row: DelegationHistoryInsert): boolean {
        const isInsert = !this.has(row.delegationId);
        const merged = (excluded: string, column: AnySQLiteColumn) =>
            sql`COALESCE(${sql.raw(`excluded.${excluded}`)}, ${column})`;
        const unlessCompacted = (value: SQL) =>
            sql`CASE WHEN ${delegationHistory.compactedAt} IS NULL THEN ${value} END`;
        this.database
            .insert(delegationHistory)
            .values(row)
            .onConflictDoUpdate({
                target: delegationHistory.delegationId,
                set: {
                    outcome: sql`excluded.outcome`,
                    failure: sql`excluded.failure`,
                    settledAt: sql`excluded.settled_at`,
                    inputTokens: merged('input_tokens', delegationHistory.inputTokens),
                    outputTokens: merged('output_tokens', delegationHistory.outputTokens),
                    cacheReadTokens: merged('cache_read_tokens', delegationHistory.cacheReadTokens),
                    cacheWriteTokens: merged(
                        'cache_write_tokens',
                        delegationHistory.cacheWriteTokens,
                    ),
                    reasoningTokens: merged('reasoning_tokens', delegationHistory.reasoningTokens),
                    totalTokens: merged('total_tokens', delegationHistory.totalTokens),
                    usageScope: sql`COALESCE(excluded.usage_scope, ${delegationHistory.usageScope})`,
                    title: unlessCompacted(
                        sql`COALESCE(excluded.title, ${delegationHistory.title})`,
                    ),
                    summary: unlessCompacted(sql`excluded.summary`),
                    summarySource: unlessCompacted(sql`excluded.summary_source`),
                },
            })
            .run();
        return isInsert;
    }

    /**
     * Clears the title and summary of every row past the newest `limit` by `settled_at`, so a long history stays small
     * and searchable text stays recent. No row is deleted: ids, edges, outcomes, and counters stay. Returns the number
     * of rows compacted now.
     */
    private compactBeyond(limit: number, now: number): number {
        const total =
            this.database.select({ total: count() }).from(delegationHistory).get()?.total ?? 0;
        if (total <= limit) return 0;
        const cutoff = this.database
            .select({ settledAt: delegationHistory.settledAt, id: delegationHistory.delegationId })
            .from(delegationHistory)
            .orderBy(desc(delegationHistory.settledAt), desc(delegationHistory.delegationId))
            .limit(1)
            .offset(limit - 1)
            .get();
        if (!cutoff) return 0;
        return this.database
            .update(delegationHistory)
            .set({ title: null, summary: null, summarySource: null, compactedAt: now })
            .where(
                and(
                    sql`${delegationHistory.compactedAt} IS NULL`,
                    sql`(${delegationHistory.settledAt}, ${delegationHistory.delegationId}) < (${cutoff.settledAt}, ${cutoff.id})`,
                ),
            )
            .run().changes;
    }

    /**
     * Records that `parentSessionId` created `sessionId`, once. Written when the Session is created, so the path
     * survives either Session's later deletion.
     */
    recordEdge(edge: DelegationEdge & { createdAt: number }): void {
        this.database
            .insert(delegationEdges)
            .values(edge)
            .onConflictDoNothing({ target: delegationEdges.sessionId })
            .run();
    }

    /**
     * At most `limit` edges whose parent is one of `parentIds` and whose relation is one of `relations`, read in
     * bounded chunks through the `parent_session_id` index. The limit is a SQL `LIMIT`, so a parent with a huge fan-out
     * never loads more rows than the caller can use; ask for one more than needed to learn that rows were left.
     */
    childEdges(
        parentIds: readonly string[],
        relations: readonly SessionRelation[],
        limit: number,
    ): DelegationEdge[] {
        const edges: DelegationEdge[] = [];
        for (
            let start = 0;
            start < parentIds.length && edges.length < limit;
            start += EDGE_QUERY_CHUNK
        ) {
            const chunk = parentIds.slice(start, start + EDGE_QUERY_CHUNK);
            const rows = this.database
                .select()
                .from(delegationEdges)
                .where(
                    and(
                        inArray(delegationEdges.parentSessionId, chunk),
                        inArray(delegationEdges.relation, [...relations]),
                    ),
                )
                .limit(limit - edges.length)
                .all();
            for (const row of rows)
                edges.push({
                    sessionId: row.sessionId,
                    parentSessionId: row.parentSessionId,
                    relation: row.relation as SessionRelation,
                });
        }
        return edges;
    }

    has(delegationId: string): boolean {
        return (
            this.database
                .select({ id: delegationHistory.delegationId })
                .from(delegationHistory)
                .where(eq(delegationHistory.delegationId, delegationId))
                .get() !== undefined
        );
    }

    /**
     * Writes one settle and, when the row is new, compacts past `searchableCap` in the same transaction. Returns
     * whether the row was new and how many rows were compacted.
     */
    record(
        row: DelegationHistoryInsert,
        searchableCap: number,
        now: number,
    ): { isInsert: boolean; compactedCount: number } {
        return this.database.transaction(() => {
            const isInsert = this.upsert(row);
            return {
                isInsert,
                compactedCount: isInsert ? this.compactBeyond(searchableCap, now) : 0,
            };
        });
    }

    /**
     * One keyset page, newest created first. Reads `limit + 1` rows; the caller trims the extra one.
     */
    page(query: DelegationHistoryPageQuery): DelegationHistoryRow[] {
        const { scope, pattern, outcome, after, limit } = query;
        const conditions: SQL[] = [];
        if (scope.kind === 'caller') {
            conditions.push(
                sql`${delegationHistory.ownerTerminalId} IS ${scope.terminalId ?? null}`,
            );
            if (!scope.anyPrincipal)
                conditions.push(eq(delegationHistory.ownerPrincipalHash, scope.principalHash));
        }
        if (outcome) conditions.push(eq(delegationHistory.outcome, outcome));
        if (pattern)
            conditions.push(
                or(
                    sql`${delegationHistory.title} LIKE ${pattern} ESCAPE '\\'`,
                    sql`${delegationHistory.summary} LIKE ${pattern} ESCAPE '\\'`,
                )!,
            );
        if (after)
            conditions.push(
                sql`(${delegationHistory.createdAt}, ${delegationHistory.delegationId}) < (${after.createdAt}, ${after.delegationId})`,
            );
        return this.database
            .select()
            .from(delegationHistory)
            .where(and(...conditions))
            .orderBy(desc(delegationHistory.createdAt), desc(delegationHistory.delegationId))
            .limit(limit + 1)
            .all();
    }
}
