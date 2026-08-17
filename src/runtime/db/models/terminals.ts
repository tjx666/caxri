import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';

import type {
    AgentProvider,
    ProcessState,
    TerminalFailureReason,
    TerminalKind,
    TerminalRecord,
} from '../../../shared/types';
import type { CaxriDrizzleDatabase } from '../connection';
import { terminals } from '../schema';

export const MAX_TERMINALS_PER_SESSION = 16;
export const MAX_TERMINALS_GLOBAL = 32;

interface TerminalRow {
    id: string;
    sessionId: string;
    kind: string;
    provider: string | null;
    cwd: string;
    title: string;
    icon: string;
    orderIndex: number;
    layoutNodeId: string;
    agentSessionId: string | null;
    lastProcessState: string;
    failureReason: string | null;
    createdAt: number;
    updatedAt: number;
}

function mapTerminal(row: TerminalRow): TerminalRecord {
    return {
        id: row.id,
        sessionId: row.sessionId,
        kind: row.kind as TerminalKind,
        provider: (row.provider as AgentProvider | null) ?? undefined,
        cwd: row.cwd,
        title: row.title,
        icon: row.icon,
        orderIndex: row.orderIndex,
        layoutNodeId: row.layoutNodeId,
        agentSessionId: row.agentSessionId ?? undefined,
        lastProcessState: row.lastProcessState as ProcessState,
        failureReason: (row.failureReason as TerminalFailureReason | null) ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export interface NewTerminalInput {
    sessionId: string;
    kind: TerminalKind;
    cwd: string;
    title: string;
}

/**
 * Pure CRUD over the `terminals` table. `order_index` is assigned atomically from the current per-Session maximum
 * (`COALESCE(MAX(order_index) + 1, 0)`), so a Terminal removed from the middle of a Session never collides with a
 * surviving one's index. Every caller shares this one INSERT instead of duplicating it.
 */
export class TerminalsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Stable order: `order_index` first, `id` breaks ties for any legacy equal-index rows.
     */
    list(sessionId?: string): TerminalRecord[] {
        const rows = sessionId
            ? this.database
                  .select()
                  .from(terminals)
                  .where(eq(terminals.sessionId, sessionId))
                  .orderBy(asc(terminals.orderIndex), asc(terminals.id))
                  .all()
            : this.database
                  .select()
                  .from(terminals)
                  .orderBy(asc(terminals.sessionId), asc(terminals.orderIndex), asc(terminals.id))
                  .all();
        return rows.map(mapTerminal);
    }

    get(id: string): TerminalRecord | undefined {
        const row = this.database.select().from(terminals).where(eq(terminals.id, id)).get();
        return row ? mapTerminal(row) : undefined;
    }

    countAll(): number {
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(terminals)
            .get()!;
        return row.count;
    }

    countForSession(sessionId: string): number {
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(terminals)
            .where(eq(terminals.sessionId, sessionId))
            .get()!;
        return row.count;
    }

    insert(input: NewTerminalInput): TerminalRecord {
        const id = randomUUID();
        const now = Date.now();
        /**
         * Mirrors the original `COALESCE((SELECT MAX(order_index) + 1 FROM terminals WHERE session_id = ?), 0)`
         * insert-time subquery so a Terminal removed from the middle of a Session never collides with a surviving one's
         * `order_index`.
         */
        const orderIndex = sql<number>`COALESCE((SELECT MAX(${terminals.orderIndex}) + 1 FROM ${terminals} WHERE ${terminals.sessionId} = ${input.sessionId}), 0)`;
        this.database
            .insert(terminals)
            .values({
                id,
                sessionId: input.sessionId,
                kind: input.kind,
                provider: input.kind === 'shell' ? null : input.kind,
                cwd: input.cwd,
                title: input.title,
                icon: input.kind,
                orderIndex,
                layoutNodeId: randomUUID(),
                lastProcessState: 'starting',
                createdAt: now,
                updatedAt: now,
            })
            .run();
        return this.get(id)!;
    }

    remove(id: string): boolean {
        return this.database.delete(terminals).where(eq(terminals.id, id)).run().changes === 1;
    }

    /**
     * `failureReason` is only meaningful alongside `state === 'failed'`; every other state clears it.
     */
    updateState(
        id: string,
        state: ProcessState,
        failureReason?: TerminalFailureReason,
        now = Date.now(),
    ): void {
        this.database
            .update(terminals)
            .set({
                lastProcessState: state,
                failureReason: state === 'failed' ? (failureReason ?? null) : null,
                updatedAt: now,
            })
            .where(eq(terminals.id, id))
            .run();
    }

    updateAgentSessionId(id: string, agentSessionId: string | undefined, now = Date.now()): void {
        this.database
            .update(terminals)
            .set({ agentSessionId: agentSessionId ?? null, updatedAt: now })
            .where(eq(terminals.id, id))
            .run();
    }

    /**
     * Reclassifies an existing Agent Terminal onto a different provider after the user launched another agent in the
     * same PTY. The provider-owned session binding is cleared so the coordinator's follow-up probe can adopt the new
     * provider's session.
     */
    switchAgentProvider(
        id: string,
        provider: AgentProvider,
        title: string,
        now = Date.now(),
    ): boolean {
        return (
            this.database
                .update(terminals)
                .set({
                    kind: provider,
                    provider,
                    title,
                    icon: provider,
                    agentSessionId: null,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(terminals.id, id),
                        sql`${terminals.provider} IS NOT NULL`,
                        sql`${terminals.provider} != ${provider}`,
                    ),
                )
                .run().changes === 1
        );
    }

    promoteShellToAgent(
        id: string,
        provider: AgentProvider,
        title: string,
        now = Date.now(),
    ): boolean {
        return (
            this.database
                .update(terminals)
                .set({ kind: provider, provider, title, icon: provider, updatedAt: now })
                .where(
                    and(
                        eq(terminals.id, id),
                        eq(terminals.kind, 'shell'),
                        sql`${terminals.provider} IS NULL`,
                    ),
                )
                .run().changes === 1
        );
    }
}
