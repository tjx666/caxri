import { randomUUID } from 'node:crypto';

import type {
    AgentProvider,
    ProcessState,
    TerminalFailureReason,
    TerminalKind,
    TerminalRecord,
    TerminalSurface,
} from '@caxri/protocol';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { terminals } from '../schema';
import type { AgentSessionUsageModel } from './agent-session-usage';

export const MAX_TERMINALS_PER_SESSION = 16;
export const MAX_TERMINALS_GLOBAL = 32;
const LIVE_PROCESS_STATES: readonly ProcessState[] = ['starting', 'running'];

interface TerminalRow {
    id: string;
    sessionId: string;
    kind: string;
    provider: string | null;
    cwd: string;
    agentCwd: string | null;
    title: string;
    ptyTitle: string | null;
    icon: string;
    orderIndex: number;
    agentSessionId: string | null;
    lastAgentProcessState: string | null;
    lastProcessState: string;
    failureReason: string | null;
    failureDetail: string | null;
    createdAt: number;
    updatedAt: number;
    surface: string;
}

function mapTerminal(row: TerminalRow): TerminalRecord {
    return {
        id: row.id,
        sessionId: row.sessionId,
        kind: row.kind as TerminalKind,
        ...(row.surface === 'chat' && { surface: 'chat' as const }),
        provider: (row.provider as AgentProvider | null) ?? undefined,
        cwd: row.cwd,
        agentCwd: row.agentCwd ?? undefined,
        title: row.title,
        ptyTitle: row.ptyTitle ?? undefined,
        icon: row.icon,
        orderIndex: row.orderIndex,
        agentSessionId: row.agentSessionId ?? undefined,
        lastAgentProcessState: (row.lastAgentProcessState as ProcessState | null) ?? undefined,
        lastProcessState: row.lastProcessState as ProcessState,
        failureReason: (row.failureReason as TerminalFailureReason | null) ?? undefined,
        failureDetail: row.failureDetail ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export interface NewTerminalInput {
    sessionId: string;
    kind: TerminalKind;
    cwd: string;
    title: string;
    surface?: TerminalSurface;
}

/**
 * Pure CRUD over the `terminals` table. `order_index` is assigned atomically from the current per-Session maximum
 * (`COALESCE(MAX(order_index) + 1, 0)`), so a Terminal removed from the middle of a Session never collides with a
 * surviving one's index. Every caller shares this one INSERT instead of duplicating it.
 */
export class TerminalsModel {
    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly usageLedger?: Pick<AgentSessionUsageModel, 'recordBindings'>,
    ) {}

    /**
     * `(session_id, order_index)` is unique, so it alone defines a stable order.
     */
    list(sessionId?: string): TerminalRecord[] {
        const rows = sessionId
            ? this.database
                  .select()
                  .from(terminals)
                  .where(eq(terminals.sessionId, sessionId))
                  .orderBy(asc(terminals.orderIndex))
                  .all()
            : this.database
                  .select()
                  .from(terminals)
                  .orderBy(asc(terminals.sessionId), asc(terminals.orderIndex))
                  .all();
        return rows.map(mapTerminal);
    }

    get(id: string): TerminalRecord | undefined {
        const row = this.database.select().from(terminals).where(eq(terminals.id, id)).get();
        return row ? mapTerminal(row) : undefined;
    }

    /**
     * Capacity counts only Terminals that still own a process. Exited, interrupted, and suspended records keep their
     * scrollback and Agent session binding indefinitely, so counting them would let dormant tabs starve new work.
     */
    countAll(): number {
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(terminals)
            .where(inArray(terminals.lastProcessState, LIVE_PROCESS_STATES))
            .get()!;
        return row.count;
    }

    countForSession(sessionId: string): number {
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(terminals)
            .where(
                and(
                    eq(terminals.sessionId, sessionId),
                    inArray(terminals.lastProcessState, LIVE_PROCESS_STATES),
                ),
            )
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
                surface: input.surface ?? 'pty',
                provider: input.kind === 'shell' ? null : input.kind,
                cwd: input.cwd,
                title: input.title,
                icon: input.kind,
                orderIndex,
                lastAgentProcessState: input.kind === 'shell' ? null : 'starting',
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
        failureDetail?: string,
        now = Date.now(),
    ): void {
        this.database
            .update(terminals)
            .set({
                lastProcessState: state,
                failureReason: state === 'failed' ? (failureReason ?? null) : null,
                failureDetail: state === 'failed' ? (failureDetail ?? null) : null,
                updatedAt: now,
            })
            .where(eq(terminals.id, id))
            .run();
    }

    /**
     * Only `terminal.switchSurface` changes a surface after creation; it stops the old process first (ADR 0012).
     */
    updateSurface(id: string, surface: TerminalSurface, now = Date.now()): void {
        this.database
            .update(terminals)
            .set({ surface, updatedAt: now })
            .where(and(eq(terminals.id, id), sql`${terminals.provider} IS NOT NULL`))
            .run();
    }

    /**
     * Every non-empty binding is also appended to the usage ledger in the same statement sequence, because the column
     * written here is overwritten by the next `/clear`, provider switch, or Terminal close.
     */
    updateAgentSessionId(id: string, agentSessionId: string | undefined, now = Date.now()): void {
        this.database
            .update(terminals)
            .set({ agentSessionId: agentSessionId ?? null, updatedAt: now })
            .where(eq(terminals.id, id))
            .run();
        if (agentSessionId) this.usageLedger?.recordBindings(id, now);
    }

    /**
     * Records the Agent's diverged working directory, or clears it when the Agent returned to the launch root. The
     * caller owns proving the path against Git worktree topology first; this model performs no path authorization.
     */
    updateAgentCwd(id: string, agentCwd: string | undefined, now = Date.now()): boolean {
        return (
            this.database
                .update(terminals)
                .set({ agentCwd: agentCwd ?? null, updatedAt: now })
                .where(and(eq(terminals.id, id), sql`${terminals.provider} IS NOT NULL`))
                .run().changes > 0
        );
    }

    updateAgentProcessState(id: string, state: ProcessState, now = Date.now()): void {
        this.database
            .update(terminals)
            .set({ lastAgentProcessState: state, updatedAt: now })
            .where(and(eq(terminals.id, id), sql`${terminals.provider} IS NOT NULL`))
            .run();
    }

    /**
     * Restores interactive Agent availability only after the coordinator confirms that the bound provider owns the
     * Shell's foreground process group. This does not create a managed launch ID or grant process-control authority.
     */
    reactivateAgentProcess(id: string, provider: AgentProvider, now = Date.now()): boolean {
        return (
            this.database
                .update(terminals)
                .set({ lastAgentProcessState: 'running', updatedAt: now })
                .where(
                    and(
                        eq(terminals.id, id),
                        eq(terminals.provider, provider),
                        eq(terminals.lastProcessState, 'running'),
                        notInArray(terminals.lastAgentProcessState, ['starting', 'running']),
                    ),
                )
                .run().changes === 1
        );
    }

    /**
     * Revokes interactive availability after repeated process probes confirm that an unmanaged Agent no longer owns the
     * live Shell's foreground process group. Managed lifecycle state is cancelled before it can reach this path.
     */
    deactivateForegroundAgentProcess(
        id: string,
        provider: AgentProvider,
        now = Date.now(),
    ): boolean {
        return (
            this.database
                .update(terminals)
                .set({ lastAgentProcessState: 'stopped', updatedAt: now })
                .where(
                    and(
                        eq(terminals.id, id),
                        eq(terminals.provider, provider),
                        eq(terminals.lastProcessState, 'running'),
                        eq(terminals.lastAgentProcessState, 'running'),
                    ),
                )
                .run().changes === 1
        );
    }

    /**
     * Marks only Agent child processes that were still live. The outer Shell is intentionally untouched so callers can
     * retire an Agent without ending the durable PTY.
     */
    markAgentProcessesShutdown(
        liveProcessStates: readonly ProcessState[],
        state: ProcessState,
        now = Date.now(),
    ): void {
        this.database
            .update(terminals)
            .set({ lastAgentProcessState: state, updatedAt: now })
            .where(inArray(terminals.lastAgentProcessState, liveProcessStates))
            .run();
    }

    /**
     * Reclassifies an existing Agent Terminal onto a different provider after the user launched another agent in the
     * same PTY. The provider-owned session binding is cleared so the coordinator's follow-up probe can adopt the new
     * provider's session. The prior process's PTY title is cleared atomically so display falls back to the new stable
     * provider title until the replacement process reports its own.
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
                    ptyTitle: null,
                    icon: provider,
                    agentSessionId: null,
                    lastAgentProcessState: 'running',
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

    /**
     * Provider-agnostic persistence primitive for the stable semantic title: what the Terminal _is_, not what its
     * process last announced. Production Agent metadata supplies the conversation name; production OSC 0/2 handling
     * never calls this setter and follows the Shell-only policy documented by {@link setPtyTitle}.
     */
    setTitle(id: string, title: string, now = Date.now()): boolean {
        return (
            this.database
                .update(terminals)
                .set({ title, updatedAt: now })
                .where(and(eq(terminals.id, id), sql`${terminals.title} != ${title}`))
                .run().changes === 1
        );
    }

    /**
     * Provider-agnostic persistence primitive for a live PTY display title. The production OSC 0/2 listener calls it
     * only for Shell Terminals and discards the signal at the listener boundary after a Terminal binds an Agent. The
     * stable `title` remains the semantic identity used outside the tab strip. Returns `false` when the row is gone or
     * already carries this PTY title, which is the caller's signal to skip the Renderer broadcast: Shells re-report an
     * unchanged title on every prompt.
     */
    setPtyTitle(id: string, ptyTitle: string, now = Date.now()): boolean {
        return (
            this.database
                .update(terminals)
                .set({ ptyTitle, updatedAt: now })
                .where(
                    and(
                        eq(terminals.id, id),
                        sql`${terminals.ptyTitle} IS NULL OR ${terminals.ptyTitle} != ${ptyTitle}`,
                    ),
                )
                .run().changes === 1
        );
    }

    /**
     * Moves a Terminal row to a different Session, resetting `order_index` to `0` since the destination is always a
     * brand-new Session in the only current caller (`CaxriDatabase.moveTerminalToNewSession`).
     */
    reassignSession(id: string, sessionId: string, now = Date.now()): void {
        this.database
            .update(terminals)
            .set({ sessionId, orderIndex: 0, updatedAt: now })
            .where(eq(terminals.id, id))
            .run();
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
                .set({
                    kind: provider,
                    provider,
                    title,
                    ptyTitle: null,
                    icon: provider,
                    lastAgentProcessState: 'running',
                    updatedAt: now,
                })
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
