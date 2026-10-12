import type {
    CommanderInboxCloseReason,
    CommanderInboxItem,
    CommanderInboxKind,
    CommanderInboxReply,
    CommanderInboxReplySource,
    CommanderInboxStaleReason,
} from '@caxri/protocol';
import {
    CaxriError,
    commanderInboxCloseReasonSchema,
    commanderInboxKindSchema,
    commanderInboxReplySourceSchema,
    commanderInboxStaleReasonSchema,
    commanderInboxStatusSchema,
    MAX_COMMANDER_INBOX_CLOSED_ITEMS,
    MAX_COMMANDER_INBOX_OPEN_ITEMS,
    MAX_COMMANDER_INBOX_REPLIES,
    parseCommanderInboxPullRequestUrl,
} from '@caxri/protocol';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { CaxriDrizzleDatabase } from '../connection';
import { commanderInboxItems, commanderInboxReplies } from '../schema-commander';

/**
 * An Inbox item as stored: everything but GitHub's live view of a `merge` item's pull request, which the service keeps
 * in memory.
 */
export type StoredCommanderInboxItem = Omit<CommanderInboxItem, 'pullRequestLive'>;

export interface CommanderInboxItemValues {
    title: string;
    body: string;
    options: readonly string[];
    sessionId?: string;
    delegationId?: string;
    pullRequest?: { url: string; headSha: string };
}

type ItemRow = typeof commanderInboxItems.$inferSelect;

const optionsSchema = z.array(z.string());

function toReply(row: typeof commanderInboxReplies.$inferSelect): CommanderInboxReply {
    return {
        sequence: row.sequence,
        body: row.body,
        source: commanderInboxReplySourceSchema.parse(row.source),
        createdAt: row.createdAt,
    };
}

function toItem(row: ItemRow, replies: CommanderInboxReply[]): StoredCommanderInboxItem {
    return {
        id: row.id,
        kind: commanderInboxKindSchema.parse(row.kind),
        status: commanderInboxStatusSchema.parse(row.status),
        ...(row.closeReason && {
            closeReason: commanderInboxCloseReasonSchema.parse(row.closeReason),
        }),
        ...(row.staleReason && {
            staleReason: commanderInboxStaleReasonSchema.parse(row.staleReason),
        }),
        title: row.title,
        body: row.body,
        options: optionsSchema.parse(JSON.parse(row.optionsJson)),
        ...(row.sessionId && { sessionId: row.sessionId }),
        ...(row.delegationId && { delegationId: row.delegationId }),
        ...(row.pullRequestUrl &&
            row.pullRequestHeadSha && {
                pullRequest: {
                    url: row.pullRequestUrl,
                    ...parseCommanderInboxPullRequestUrl(row.pullRequestUrl),
                    headSha: row.pullRequestHeadSha,
                },
            }),
        replies,
        acknowledgedSequence: row.acknowledgedSequence,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.closedAt !== null && { closedAt: row.closedAt }),
    };
}

/**
 * Storage for the Commander Inbox. Every mutation bumps `updated_at`. `revision` counts the Commander's reports: only a
 * new report (insert or replace) or a close bumps it, in the same statement, so the owner's merge names the report they
 * read. A reply, an acknowledgement, or a stale mark leaves it alone, so none of them refuses that merge.
 */
export class CommanderInboxModel {
    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly transaction: <T>(work: () => T) => T,
    ) {}

    private repliesFor(itemIds: readonly string[]): Map<string, CommanderInboxReply[]> {
        const byItem = new Map<string, CommanderInboxReply[]>();
        if (itemIds.length === 0) return byItem;
        const rows = this.database
            .select()
            .from(commanderInboxReplies)
            .where(inArray(commanderInboxReplies.itemId, [...itemIds]))
            .orderBy(asc(commanderInboxReplies.itemId), asc(commanderInboxReplies.sequence))
            .all();
        for (const row of rows) {
            const replies = byItem.get(row.itemId) ?? [];
            replies.push(toReply(row));
            byItem.set(row.itemId, replies);
        }
        return byItem;
    }

    private withReplies(rows: readonly ItemRow[]): StoredCommanderInboxItem[] {
        const replies = this.repliesFor(rows.map((row) => row.id));
        return rows.map((row) => toItem(row, replies.get(row.id) ?? []));
    }

    private insertOpen(
        id: string,
        kind: CommanderInboxKind,
        key: string | undefined,
        values: CommanderInboxItemValues,
        now: number,
    ): StoredCommanderInboxItem {
        const openCount = this.database
            .select({ value: sql<number>`count(*)` })
            .from(commanderInboxItems)
            .where(eq(commanderInboxItems.status, 'open'))
            .get()!.value;
        if (openCount >= MAX_COMMANDER_INBOX_OPEN_ITEMS)
            throw new CaxriError(
                'CAPACITY',
                `The Inbox already holds ${MAX_COMMANDER_INBOX_OPEN_ITEMS} open items; resolve some first`,
            );
        this.database
            .insert(commanderInboxItems)
            .values({
                id,
                kind,
                dedupKey: key ?? null,
                status: 'open',
                title: values.title,
                body: values.body,
                optionsJson: JSON.stringify(values.options),
                sessionId: values.sessionId ?? null,
                delegationId: values.delegationId ?? null,
                pullRequestUrl: values.pullRequest?.url ?? null,
                pullRequestHeadSha: values.pullRequest?.headSha ?? null,
                createdAt: now,
                updatedAt: now,
            })
            .run();
        return this.get(id)!;
    }

    private insertReply(
        id: string,
        body: string,
        source: CommanderInboxReplySource,
        now: number,
    ): number {
        const item = this.get(id);
        if (!item) throw new CaxriError('NOT_FOUND', 'Inbox item not found');
        if (item.status !== 'open') throw new CaxriError('CONFLICT', 'This Inbox item is closed');
        if (item.replies.length >= MAX_COMMANDER_INBOX_REPLIES)
            throw new CaxriError(
                'CAPACITY',
                `An Inbox item holds at most ${MAX_COMMANDER_INBOX_REPLIES} replies`,
            );
        const sequence = (item.replies.at(-1)?.sequence ?? 0) + 1;
        this.database
            .insert(commanderInboxReplies)
            .values({ itemId: id, sequence, body, source, createdAt: now })
            .run();
        this.database
            .update(commanderInboxItems)
            .set({ updatedAt: now })
            .where(eq(commanderInboxItems.id, id))
            .run();
        return sequence;
    }

    private closeOpen(id: string, reason: CommanderInboxCloseReason, now: number): boolean {
        const isChanged =
            this.database
                .update(commanderInboxItems)
                .set({
                    status: 'closed',
                    closeReason: reason,
                    revision: sql`${commanderInboxItems.revision} + 1`,
                    updatedAt: now,
                    closedAt: now,
                })
                .where(and(eq(commanderInboxItems.id, id), eq(commanderInboxItems.status, 'open')))
                .run().changes === 1;
        if (isChanged) this.pruneClosed();
        return isChanged;
    }

    private pruneClosed(): void {
        const retained = this.database
            .select({ id: commanderInboxItems.id })
            .from(commanderInboxItems)
            .where(eq(commanderInboxItems.status, 'closed'))
            .orderBy(desc(commanderInboxItems.closedAt))
            .limit(MAX_COMMANDER_INBOX_CLOSED_ITEMS)
            .all()
            .map((row) => row.id);
        this.database
            .delete(commanderInboxItems)
            .where(
                and(
                    eq(commanderInboxItems.status, 'closed'),
                    retained.length > 0 ? notInArray(commanderInboxItems.id, retained) : sql`1 = 1`,
                ),
            )
            .run();
    }

    get(id: string): StoredCommanderInboxItem | undefined {
        const row = this.database
            .select()
            .from(commanderInboxItems)
            .where(eq(commanderInboxItems.id, id))
            .get();
        return row ? this.withReplies([row])[0] : undefined;
    }

    /**
     * Open items newest first, then, when asked, the most recently closed ones.
     */
    list(isClosedIncluded: boolean): StoredCommanderInboxItem[] {
        const open = this.database
            .select()
            .from(commanderInboxItems)
            .where(eq(commanderInboxItems.status, 'open'))
            .orderBy(desc(commanderInboxItems.updatedAt))
            .limit(MAX_COMMANDER_INBOX_OPEN_ITEMS)
            .all();
        const closed = isClosedIncluded
            ? this.database
                  .select()
                  .from(commanderInboxItems)
                  .where(eq(commanderInboxItems.status, 'closed'))
                  .orderBy(desc(commanderInboxItems.closedAt))
                  .limit(MAX_COMMANDER_INBOX_CLOSED_ITEMS)
                  .all()
            : [];
        return this.withReplies([...open, ...closed]);
    }

    findOpen(kind: CommanderInboxKind, key: string): StoredCommanderInboxItem | undefined {
        const row = this.database
            .select()
            .from(commanderInboxItems)
            .where(
                and(
                    eq(commanderInboxItems.status, 'open'),
                    eq(commanderInboxItems.kind, kind),
                    eq(commanderInboxItems.dedupKey, key),
                ),
            )
            .get();
        return row ? this.withReplies([row])[0] : undefined;
    }

    /**
     * Open `merge` items, whose pull requests the service reconciles against GitHub.
     */
    openMergeItems(): StoredCommanderInboxItem[] {
        const isOpenMerge = and(
            eq(commanderInboxItems.status, 'open'),
            eq(commanderInboxItems.kind, 'merge'),
        );
        return this.withReplies(
            this.database.select().from(commanderInboxItems).where(isOpenMerge).all(),
        );
    }

    /**
     * Open items with a reply the Commander has not acknowledged, with the highest unread sequence.
     */
    unacknowledged(): Array<{ id: string; sequence: number }> {
        return this.database
            .select({
                id: commanderInboxItems.id,
                sequence: sql<number>`max(${commanderInboxReplies.sequence})`,
            })
            .from(commanderInboxItems)
            .innerJoin(
                commanderInboxReplies,
                eq(commanderInboxReplies.itemId, commanderInboxItems.id),
            )
            .where(eq(commanderInboxItems.status, 'open'))
            .groupBy(commanderInboxItems.id)
            .having(
                sql`max(${commanderInboxReplies.sequence}) > ${commanderInboxItems.acknowledgedSequence}`,
            )
            .all();
    }

    insert(
        id: string,
        kind: CommanderInboxKind,
        key: string | undefined,
        values: CommanderInboxItemValues,
        now: number,
    ): StoredCommanderInboxItem {
        return this.transaction(() => this.insertOpen(id, kind, key, values, now));
    }

    /**
     * Replaces the Commander-authored fields of an open item. A new report is new evidence, so it also clears a stale
     * mark.
     */
    replace(id: string, values: CommanderInboxItemValues, now: number): StoredCommanderInboxItem {
        this.database
            .update(commanderInboxItems)
            .set({
                title: values.title,
                body: values.body,
                optionsJson: JSON.stringify(values.options),
                sessionId: values.sessionId ?? null,
                delegationId: values.delegationId ?? null,
                pullRequestUrl: values.pullRequest?.url ?? null,
                pullRequestHeadSha: values.pullRequest?.headSha ?? null,
                staleReason: null,
                revision: sql`${commanderInboxItems.revision} + 1`,
                updatedAt: now,
            })
            .where(and(eq(commanderInboxItems.id, id), eq(commanderInboxItems.status, 'open')))
            .run();
        return this.get(id)!;
    }

    setStale(id: string, reason: CommanderInboxStaleReason | undefined, now: number): boolean {
        return (
            this.database
                .update(commanderInboxItems)
                .set({ staleReason: reason ?? null, updatedAt: now })
                .where(
                    and(
                        eq(commanderInboxItems.id, id),
                        eq(commanderInboxItems.status, 'open'),
                        reason === undefined
                            ? sql`${commanderInboxItems.staleReason} IS NOT NULL`
                            : sql`${commanderInboxItems.staleReason} IS NOT ${reason}`,
                    ),
                )
                .run().changes === 1
        );
    }

    /**
     * Appends one reply and returns its sequence. Refuses a closed item, and an item that already holds the maximum
     * number of replies.
     */
    appendReply(id: string, body: string, source: CommanderInboxReplySource, now: number): number {
        return this.transaction(() => this.insertReply(id, body, source, now));
    }

    /**
     * Raises the acknowledged sequence; never lowers it, so a late, older acknowledgement changes nothing.
     */
    acknowledge(id: string, sequence: number, now: number): boolean {
        return (
            this.database
                .update(commanderInboxItems)
                .set({ acknowledgedSequence: sequence, updatedAt: now })
                .where(
                    and(
                        eq(commanderInboxItems.id, id),
                        sql`${commanderInboxItems.acknowledgedSequence} < ${sequence}`,
                    ),
                )
                .run().changes === 1
        );
    }

    /**
     * Closes an open item and prunes the oldest closed items beyond the retained window. Returns false when the item
     * was not open.
     */
    close(id: string, reason: CommanderInboxCloseReason, now: number): boolean {
        return this.transaction(() => this.closeOpen(id, reason, now));
    }
}
