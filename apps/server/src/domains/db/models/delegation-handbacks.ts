import { and, eq, inArray } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import type { DelegationHandBackState, DelegationHandBackTrigger } from '../schema';
import { delegationHandBacks } from '../schema';

/**
 * A hand-back grant as stored; see `delegationHandBacks`. Identifiers and numbers only.
 */
export interface StoredDelegationHandBack {
    id: string;
    /**
     * The task the grant continues: the follow-up names it.
     */
    delegationId: string;
    sessionId: string;
    /**
     * The child's Terminal and what the grant pinned of it.
     */
    terminalId: string;
    launchId: string;
    providerSessionId: string;
    turnId: string;
    inputEpoch: number;
    /**
     * The delegating Agent's Terminal and launch.
     */
    callerTerminalId: string;
    callerLaunchId: string;
    state: DelegationHandBackState;
    trigger: DelegationHandBackTrigger;
    /**
     * The task that used the grant; present exactly when `state` is `consumed`.
     */
    consumedBy?: string;
    createdAt: number;
    updatedAt: number;
}

function toStored(row: typeof delegationHandBacks.$inferSelect): StoredDelegationHandBack {
    return {
        id: row.id,
        delegationId: row.delegationId,
        sessionId: row.sessionId,
        terminalId: row.terminalId,
        launchId: row.launchId,
        providerSessionId: row.providerSessionId,
        turnId: row.turnId,
        inputEpoch: row.inputEpoch,
        callerTerminalId: row.callerTerminalId,
        callerLaunchId: row.callerLaunchId,
        state: row.state as DelegationHandBackState,
        trigger: row.trigger as DelegationHandBackTrigger,
        ...(row.consumedBy !== null && { consumedBy: row.consumedBy }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/**
 * Pure persistence for hand-back grants. It never decides and never logs: the delegation domain owns when a grant may
 * be given, used, or dropped. Every transition is one conditional `UPDATE`, so two requests racing for a grant cannot
 * both use it.
 */
export class DelegationHandBacksModel {
    /**
     * Terminals that may hold a pending grant, so per-keystroke `pendingForTerminal` reads skip SQLite for the vast
     * majority of Terminals. Only ever a superset of the truth: seeded lazily from the table, grown by `insert` and
     * `release`, and pruned when a lookup finds nothing. A grant leaving `pending` (or cascading away) can only make an
     * entry stale, which costs one confirming read, never a missed grant.
     */
    private pendingTerminals: Set<string> | undefined;

    constructor(private readonly database: CaxriDrizzleDatabase) {}

    private queryPendingForTerminal(terminalId: string): StoredDelegationHandBack[] {
        return this.database
            .select()
            .from(delegationHandBacks)
            .where(
                and(
                    eq(delegationHandBacks.terminalId, terminalId),
                    eq(delegationHandBacks.state, 'pending'),
                ),
            )
            .all()
            .map((row) => toStored(row));
    }

    /**
     * Stores a pending grant. Returns false when its task already has a pending one.
     */
    insert(grant: Omit<StoredDelegationHandBack, 'state' | 'updatedAt' | 'consumedBy'>): boolean {
        const isInserted =
            this.database
                .insert(delegationHandBacks)
                .values({ ...grant, state: 'pending', updatedAt: grant.createdAt })
                .onConflictDoNothing()
                .run().changes === 1;
        if (isInserted) this.pendingTerminals?.add(grant.terminalId);
        return isInserted;
    }

    get(id: string): StoredDelegationHandBack | undefined {
        const row = this.database
            .select()
            .from(delegationHandBacks)
            .where(eq(delegationHandBacks.id, id))
            .get();
        return row && toStored(row);
    }

    /**
     * The pending grant of one task, if any.
     */
    pendingForDelegation(delegationId: string): StoredDelegationHandBack | undefined {
        const row = this.database
            .select()
            .from(delegationHandBacks)
            .where(
                and(
                    eq(delegationHandBacks.delegationId, delegationId),
                    eq(delegationHandBacks.state, 'pending'),
                ),
            )
            .get();
        return row && toStored(row);
    }

    /**
     * Every pending grant of the named child Terminal.
     */
    pendingForTerminal(terminalId: string): StoredDelegationHandBack[] {
        this.pendingTerminals ??= new Set(this.pending().map((grant) => grant.terminalId));
        if (!this.pendingTerminals.has(terminalId)) return [];
        const grants = this.queryPendingForTerminal(terminalId);
        if (grants.length === 0) this.pendingTerminals.delete(terminalId);
        return grants;
    }

    /**
     * Every pending grant, for the restart sweep.
     */
    pending(): StoredDelegationHandBack[] {
        return this.database
            .select()
            .from(delegationHandBacks)
            .where(eq(delegationHandBacks.state, 'pending'))
            .all()
            .map((row) => toStored(row));
    }

    /**
     * The grants of the named Sessions in any state, oldest first, for the feed's control state.
     */
    forSessions(sessionIds: readonly string[]): StoredDelegationHandBack[] {
        if (sessionIds.length === 0) return [];
        return this.database
            .select()
            .from(delegationHandBacks)
            .where(inArray(delegationHandBacks.sessionId, [...sessionIds]))
            .orderBy(delegationHandBacks.createdAt, delegationHandBacks.id)
            .all()
            .map((row) => toStored(row));
    }

    /**
     * Uses a pending grant for `taskId`. Returns false when it was not pending, which is what makes a grant single-use.
     */
    consume(id: string, taskId: string, now: number): boolean {
        return (
            this.database
                .update(delegationHandBacks)
                .set({ state: 'consumed', consumedBy: taskId, updatedAt: now })
                .where(
                    and(eq(delegationHandBacks.id, id), eq(delegationHandBacks.state, 'pending')),
                )
                .run().changes === 1
        );
    }

    /**
     * Puts a grant `taskId` used back to pending, when the Host refused that task's write before anything reached the
     * conversation.
     */
    release(id: string, taskId: string, now: number): boolean {
        const isReleased =
            this.database
                .update(delegationHandBacks)
                .set({ state: 'pending', consumedBy: null, updatedAt: now })
                .where(
                    and(
                        eq(delegationHandBacks.id, id),
                        eq(delegationHandBacks.state, 'consumed'),
                        eq(delegationHandBacks.consumedBy, taskId),
                    ),
                )
                .run().changes === 1;
        const grant = isReleased && this.pendingTerminals ? this.get(id) : undefined;
        if (grant) this.pendingTerminals?.add(grant.terminalId);
        return isReleased;
    }

    /**
     * Drops pending grants for good and returns the ones this call dropped.
     */
    invalidate(ids: readonly string[], now: number): string[] {
        if (ids.length === 0) return [];
        return this.database
            .update(delegationHandBacks)
            .set({ state: 'invalidated', updatedAt: now })
            .where(
                and(
                    inArray(delegationHandBacks.id, [...ids]),
                    eq(delegationHandBacks.state, 'pending'),
                ),
            )
            .returning({ id: delegationHandBacks.id })
            .all()
            .map((row) => row.id);
    }
}
