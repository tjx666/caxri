import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import type { DelegationNoticeKind, DelegationNoticeState } from '../schema';
import { delegationNotices } from '../schema';

/**
 * A notice owed to the Agent that delegated a task, as stored; see `delegationNotices`. Identifiers and closed values
 * only.
 */
export interface StoredDelegationNotice {
    id: string;
    delegationId: string;
    kind: DelegationNoticeKind;
    /**
     * The question or request the notice names; absent for a settled task.
     */
    subjectId?: string;
    state: DelegationNoticeState;
    callerTerminalId: string;
    callerLaunchId: string;
    createdAt: number;
    updatedAt: number;
    acknowledgedAt?: number;
}

function toStored(row: typeof delegationNotices.$inferSelect): StoredDelegationNotice {
    return {
        id: row.id,
        delegationId: row.delegationId,
        kind: row.kind as DelegationNoticeKind,
        ...(row.subjectId !== null && { subjectId: row.subjectId }),
        state: row.state as DelegationNoticeState,
        callerTerminalId: row.callerTerminalId,
        callerLaunchId: row.callerLaunchId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.acknowledgedAt !== null && { acknowledgedAt: row.acknowledgedAt }),
    };
}

/**
 * Pure persistence for the notices owed to delegating Agents. It never decides and never logs: the delegation domain
 * owns when a notice is owed and when it may be sent. Every transition is one conditional `UPDATE`, so two writers
 * racing for a notice cannot both claim it.
 */
export class DelegationNoticesModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Stores a pending notice. A key that already exists is left as it is, so an event notifies once however many times
     * it is observed; returns whether this call stored it.
     */
    register(notice: {
        id: string;
        delegationId: string;
        kind: DelegationNoticeKind;
        subjectId?: string;
        callerTerminalId: string;
        callerLaunchId: string;
        now: number;
    }): boolean {
        return (
            this.database
                .insert(delegationNotices)
                .values({
                    id: notice.id,
                    delegationId: notice.delegationId,
                    kind: notice.kind,
                    subjectId: notice.subjectId ?? null,
                    state: 'pending',
                    callerTerminalId: notice.callerTerminalId,
                    callerLaunchId: notice.callerLaunchId,
                    createdAt: notice.now,
                    updatedAt: notice.now,
                })
                .onConflictDoNothing()
                .run().changes === 1
        );
    }

    get(id: string): StoredDelegationNotice | undefined {
        const row = this.database
            .select()
            .from(delegationNotices)
            .where(eq(delegationNotices.id, id))
            .get();
        return row && toStored(row);
    }

    /**
     * Every pending notice, oldest first.
     */
    pending(): StoredDelegationNotice[] {
        return this.database
            .select()
            .from(delegationNotices)
            .where(eq(delegationNotices.state, 'pending'))
            .orderBy(delegationNotices.createdAt, delegationNotices.id)
            .all()
            .map((row) => toStored(row));
    }

    /**
     * The pending notices owed to one caller launch, oldest first.
     */
    pendingFor(callerTerminalId: string, callerLaunchId: string): StoredDelegationNotice[] {
        return this.database
            .select()
            .from(delegationNotices)
            .where(
                and(
                    eq(delegationNotices.callerTerminalId, callerTerminalId),
                    eq(delegationNotices.callerLaunchId, callerLaunchId),
                    eq(delegationNotices.state, 'pending'),
                ),
            )
            .orderBy(delegationNotices.createdAt, delegationNotices.id)
            .all()
            .map((row) => toStored(row));
    }

    /**
     * Whether the caller launch is owed a pending notice, for the idle-suspension hold.
     */
    hasPendingFor(callerTerminalId: string, callerLaunchId: string): boolean {
        return (
            this.database
                .select({ one: sql<number>`1` })
                .from(delegationNotices)
                .where(
                    and(
                        eq(delegationNotices.callerTerminalId, callerTerminalId),
                        eq(delegationNotices.callerLaunchId, callerLaunchId),
                        eq(delegationNotices.state, 'pending'),
                    ),
                )
                .limit(1)
                .get() !== undefined
        );
    }

    /**
     * The notices of one task of a kind, whatever their state, for the acknowledgement of a wait outcome.
     */
    forDelegation(delegationId: string, kind: DelegationNoticeKind): StoredDelegationNotice[] {
        return this.database
            .select()
            .from(delegationNotices)
            .where(
                and(
                    eq(delegationNotices.delegationId, delegationId),
                    eq(delegationNotices.kind, kind),
                ),
            )
            .all()
            .map((row) => toStored(row));
    }

    /**
     * Moves the notices from `pending` to `state`, and returns the ones this call moved. A notice another writer
     * already moved is left out, which is what makes a claim before sending single-use.
     */
    claim(
        ids: readonly string[],
        state: Exclude<DelegationNoticeState, 'pending'>,
        now: number,
    ): string[] {
        if (ids.length === 0) return [];
        return this.database
            .update(delegationNotices)
            .set({ state, updatedAt: now })
            .where(
                and(
                    inArray(delegationNotices.id, [...ids]),
                    eq(delegationNotices.state, 'pending'),
                ),
            )
            .returning({ id: delegationNotices.id })
            .all()
            .map((row) => row.id);
    }

    /**
     * Moves a notice that is not `pending` to `to`: settles an `unknown` claim once the write is confirmed, or puts a
     * claim back to `pending` when the write was refused before anything was sent.
     */
    settle(
        id: string,
        from: Exclude<DelegationNoticeState, 'pending'>,
        to: DelegationNoticeState,
        now: number,
    ): boolean {
        return (
            this.database
                .update(delegationNotices)
                .set({ state: to, updatedAt: now })
                .where(and(eq(delegationNotices.id, id), eq(delegationNotices.state, from)))
                .run().changes === 1
        );
    }

    /**
     * Removes a pending notice so its event can be registered again. A failed task whose retry plan was cancelled owes
     * a notice again, and the key of the first one would otherwise block it.
     */
    discard(id: string): boolean {
        return (
            this.database
                .delete(delegationNotices)
                .where(and(eq(delegationNotices.id, id), eq(delegationNotices.state, 'pending')))
                .run().changes === 1
        );
    }

    /**
     * Records that the caller itself read what the notice reports, once. Returns whether the notice exists and was not
     * acknowledged before, whatever its state.
     */
    acknowledge(id: string, now: number): boolean {
        return (
            this.database
                .update(delegationNotices)
                .set({ acknowledgedAt: now })
                .where(and(eq(delegationNotices.id, id), isNull(delegationNotices.acknowledgedAt)))
                .run().changes === 1
        );
    }
}
