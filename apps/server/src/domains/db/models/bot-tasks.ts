import { randomUUID } from 'node:crypto';

import type { BotTask, BotTaskDeleteScope, BotTaskStatus } from '@caxri/protocol';
import { MAX_BOT_TASKS, openBotTaskStatuses } from '@caxri/protocol';
import { and, asc, count, desc, eq, inArray, ne, notInArray } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { botTasks } from '../schema-bot';

type BotTaskRow = typeof botTasks.$inferSelect;

function toTask(row: BotTaskRow): BotTask {
    return { ...row, status: row.status as BotTaskStatus };
}

export interface NewBotTask {
    title: string;
    status: BotTaskStatus;
    projectId?: string | null;
    sessionId?: string | null;
    delegationId?: string | null;
    note?: string | null;
}

export type BotTaskPatch = Partial<
    Pick<
        BotTask,
        'delegationId' | 'note' | 'projectId' | 'pullRequestUrl' | 'sessionId' | 'status' | 'title'
    >
>;

/**
 * Pure CRUD for Caxri Bot task ledger. Admission and delegation linking live in Caxri Bot domain
 * (`../../bot/tasks.ts`).
 */
export class BotTasksModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    get(id: string): BotTask | undefined {
        const row = this.database.select().from(botTasks).where(eq(botTasks.id, id)).get();
        return row && toTask(row);
    }

    getByDelegation(delegationId: string): BotTask | undefined {
        const row = this.database
            .select()
            .from(botTasks)
            .where(eq(botTasks.delegationId, delegationId))
            .get();
        return row && toTask(row);
    }

    countOpen(): number {
        return (
            this.database
                .select({ value: count() })
                .from(botTasks)
                .where(inArray(botTasks.status, [...openBotTaskStatuses]))
                .get()?.value ?? 0
        );
    }

    /**
     * Open tasks oldest first; with `includeClosed`, the most recently closed ones follow, up to the list bound.
     */
    list({ includeClosed }: { includeClosed: boolean }): BotTask[] {
        const open = this.database
            .select()
            .from(botTasks)
            .where(inArray(botTasks.status, [...openBotTaskStatuses]))
            .orderBy(asc(botTasks.createdAt))
            .limit(MAX_BOT_TASKS)
            .all();
        if (!includeClosed || open.length >= MAX_BOT_TASKS) return open.map(toTask);
        const closed = this.database
            .select()
            .from(botTasks)
            .where(notInArray(botTasks.status, [...openBotTaskStatuses]))
            .orderBy(desc(botTasks.updatedAt))
            .limit(MAX_BOT_TASKS - open.length)
            .all();
        return [...open, ...closed].map(toTask);
    }

    countAll(): number {
        return this.database.select({ value: count() }).from(botTasks).get()?.value ?? 0;
    }

    /**
     * Deletes the listed tasks, every task (`all`), or every closed one (`closed`, including those too old for the
     * list), and returns how many rows went. A delegation the ledger already recorded is never re-recorded by a later
     * receipt, so a deleted task stays deleted.
     */
    delete(scope: BotTaskDeleteScope): number {
        if (typeof scope !== 'string' && scope.length === 0) return 0;
        return this.database
            .delete(botTasks)
            .where(
                scope === 'all'
                    ? undefined
                    : scope === 'closed'
                      ? notInArray(botTasks.status, [...openBotTaskStatuses])
                      : inArray(botTasks.id, [...scope]),
            )
            .run().changes;
    }

    insert(input: NewBotTask, now: number): BotTask {
        const row: BotTaskRow = {
            id: randomUUID(),
            title: input.title,
            status: input.status,
            projectId: input.projectId ?? null,
            sessionId: input.sessionId ?? null,
            delegationId: input.delegationId ?? null,
            note: input.note ?? null,
            pullRequestUrl: null,
            createdAt: now,
            updatedAt: now,
        };
        this.database.insert(botTasks).values(row).run();
        return toTask(row);
    }

    /**
     * A delegation identifies at most one task. Linking one that another row already holds (the row the ledger records
     * on its own when Caxri Bot dispatches before registering) removes that row in the same transaction, so the Caxri
     * Bot's own task absorbs it instead of the update failing on the unique index.
     */
    update(id: string, patch: BotTaskPatch, now: number): BotTask | undefined {
        this.database.transaction((transaction) => {
            if (patch.delegationId)
                transaction
                    .delete(botTasks)
                    .where(and(eq(botTasks.delegationId, patch.delegationId), ne(botTasks.id, id)))
                    .run();
            transaction
                .update(botTasks)
                .set({ ...patch, updatedAt: now })
                .where(eq(botTasks.id, id))
                .run();
        });
        return this.get(id);
    }
}
