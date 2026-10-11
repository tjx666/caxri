import { randomUUID } from 'node:crypto';

import type { CommanderTask, CommanderTaskStatus } from '@caxri/protocol';
import { MAX_COMMANDER_TASKS, openCommanderTaskStatuses } from '@caxri/protocol';
import { and, asc, count, desc, eq, inArray, ne, notInArray } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { commanderTasks } from '../schema-commander';

type CommanderTaskRow = typeof commanderTasks.$inferSelect;

function toTask(row: CommanderTaskRow): CommanderTask {
    return { ...row, status: row.status as CommanderTaskStatus };
}

export interface NewCommanderTask {
    title: string;
    status: CommanderTaskStatus;
    projectId?: string | null;
    sessionId?: string | null;
    delegationId?: string | null;
    note?: string | null;
}

export type CommanderTaskPatch = Partial<
    Pick<
        CommanderTask,
        'delegationId' | 'note' | 'projectId' | 'pullRequestUrl' | 'sessionId' | 'status' | 'title'
    >
>;

/**
 * Pure CRUD for the Commander task ledger. Admission and delegation linking live in the Commander domain
 * (`../../commander/tasks.ts`).
 */
export class CommanderTasksModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    get(id: string): CommanderTask | undefined {
        const row = this.database
            .select()
            .from(commanderTasks)
            .where(eq(commanderTasks.id, id))
            .get();
        return row && toTask(row);
    }

    getByDelegation(delegationId: string): CommanderTask | undefined {
        const row = this.database
            .select()
            .from(commanderTasks)
            .where(eq(commanderTasks.delegationId, delegationId))
            .get();
        return row && toTask(row);
    }

    countOpen(): number {
        return (
            this.database
                .select({ value: count() })
                .from(commanderTasks)
                .where(inArray(commanderTasks.status, [...openCommanderTaskStatuses]))
                .get()?.value ?? 0
        );
    }

    /**
     * Open tasks oldest first; with `includeClosed`, the most recently closed ones follow, up to the list bound.
     */
    list({ includeClosed }: { includeClosed: boolean }): CommanderTask[] {
        const open = this.database
            .select()
            .from(commanderTasks)
            .where(inArray(commanderTasks.status, [...openCommanderTaskStatuses]))
            .orderBy(asc(commanderTasks.createdAt))
            .limit(MAX_COMMANDER_TASKS)
            .all();
        if (!includeClosed || open.length >= MAX_COMMANDER_TASKS) return open.map(toTask);
        const closed = this.database
            .select()
            .from(commanderTasks)
            .where(notInArray(commanderTasks.status, [...openCommanderTaskStatuses]))
            .orderBy(desc(commanderTasks.updatedAt))
            .limit(MAX_COMMANDER_TASKS - open.length)
            .all();
        return [...open, ...closed].map(toTask);
    }

    insert(input: NewCommanderTask, now: number): CommanderTask {
        const row: CommanderTaskRow = {
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
        this.database.insert(commanderTasks).values(row).run();
        return toTask(row);
    }

    /**
     * A delegation identifies at most one task. Linking one that another row already holds (the row the ledger records
     * on its own when the Commander dispatches before registering) removes that row in the same transaction, so the
     * Commander's own task absorbs it instead of the update failing on the unique index.
     */
    update(id: string, patch: CommanderTaskPatch, now: number): CommanderTask | undefined {
        this.database.transaction((transaction) => {
            if (patch.delegationId)
                transaction
                    .delete(commanderTasks)
                    .where(
                        and(
                            eq(commanderTasks.delegationId, patch.delegationId),
                            ne(commanderTasks.id, id),
                        ),
                    )
                    .run();
            transaction
                .update(commanderTasks)
                .set({ ...patch, updatedAt: now })
                .where(eq(commanderTasks.id, id))
                .run();
        });
        return this.get(id);
    }
}
