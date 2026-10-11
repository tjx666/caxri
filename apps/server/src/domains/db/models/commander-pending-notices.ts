import { asc, eq, inArray } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { commanderPendingNotices } from '../schema-commander';

type CommanderNoticeStatus = 'completed' | 'failed' | 'needsInput';

/**
 * One notice waiting for the Commander Terminal. `delegation` reports a settled task; `interrupted_turn` marks a
 * Commander turn that started and never finished, so the next launch can tell the Commander its work was cut off.
 */
export type CommanderPendingNotice =
    | {
          kind: 'delegation';
          delegationId: string;
          sessionId: string;
          status: CommanderNoticeStatus;
          revision: number;
          queuedAt: number;
      }
    | { kind: 'interrupted_turn'; queuedAt: number };

const INTERRUPTED_TURN_KEY = 'interrupted_turn';

function delegationKey(delegationId: string): string {
    return `delegation:${delegationId}`;
}

type NoticeRow = typeof commanderPendingNotices.$inferSelect;

function toNotice(row: NoticeRow): CommanderPendingNotice | undefined {
    if (row.kind === 'interrupted_turn')
        return { kind: 'interrupted_turn', queuedAt: row.queuedAt };
    if (
        row.kind !== 'delegation' ||
        !row.delegationId ||
        !row.sessionId ||
        !row.status ||
        row.revision === null
    )
        return undefined;
    return {
        kind: 'delegation',
        delegationId: row.delegationId,
        sessionId: row.sessionId,
        status: row.status as CommanderNoticeStatus,
        revision: row.revision,
        queuedAt: row.queuedAt,
    };
}

/**
 * Pure CRUD for notices the Commander has not received yet. Rows are deleted when consumed, so the table only ever
 * holds what is still owed; the notifier owns delivery order and fencing.
 */
export class CommanderPendingNoticesModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Oldest first. A row that no longer parses is skipped rather than failing every later delivery.
     */
    list(): CommanderPendingNotice[] {
        return this.database
            .select()
            .from(commanderPendingNotices)
            .orderBy(asc(commanderPendingNotices.queuedAt))
            .all()
            .flatMap((row) => toNotice(row) ?? []);
    }

    /**
     * Keeps one pending row per delegation: a newer transition replaces the one still waiting, but keeps its queue time
     * so the wait measured at delivery covers the whole delay.
     */
    putDelegation(
        notice: Omit<Extract<CommanderPendingNotice, { kind: 'delegation' }>, 'kind'>,
    ): void {
        const { queuedAt, ...rest } = notice;
        this.database
            .insert(commanderPendingNotices)
            .values({
                key: delegationKey(notice.delegationId),
                kind: 'delegation',
                queuedAt,
                ...rest,
            })
            .onConflictDoUpdate({ target: commanderPendingNotices.key, set: rest })
            .run();
    }

    markTurnStarted(now: number): void {
        this.database
            .insert(commanderPendingNotices)
            .values({ key: INTERRUPTED_TURN_KEY, kind: 'interrupted_turn', queuedAt: now })
            .onConflictDoUpdate({ target: commanderPendingNotices.key, set: { queuedAt: now } })
            .run();
    }

    clearTurn(): void {
        this.database
            .delete(commanderPendingNotices)
            .where(eq(commanderPendingNotices.key, INTERRUPTED_TURN_KEY))
            .run();
    }

    removeDelegations(delegationIds: readonly string[]): void {
        if (delegationIds.length === 0) return;
        this.database
            .delete(commanderPendingNotices)
            .where(inArray(commanderPendingNotices.key, delegationIds.map(delegationKey)))
            .run();
    }
}
