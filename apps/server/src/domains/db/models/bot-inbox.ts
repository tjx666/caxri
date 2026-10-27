import type {
    BotInboxCloseReason,
    BotInboxItem,
    BotInboxKind,
    BotInboxReply,
    BotInboxReplySource,
    BotInboxStaleReason,
} from '@caxri/protocol';
import {
    botInboxCloseReasonSchema,
    botInboxKindSchema,
    botInboxReplySourceSchema,
    botInboxStaleReasonSchema,
    botInboxStatusSchema,
    CaxriError,
    MAX_BOT_INBOX_CLOSED_ITEMS,
    MAX_BOT_INBOX_OPEN_ITEMS,
    MAX_BOT_INBOX_REPLIES,
    parseBotInboxPullRequestUrl,
} from '@caxri/protocol';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { CaxriDrizzleDatabase } from '../connection';
import { botInboxItems, botInboxReplies } from '../schema-bot';

/**
 * An Inbox item as stored: everything but GitHub's live view of a `merge` item's pull request, which the service keeps
 * in memory.
 */
export type StoredBotInboxItem = Omit<BotInboxItem, 'pullRequestLive'>;

export interface BotInboxItemValues {
    title: string;
    body: string;
    options: readonly string[];
    sessionId?: string;
    delegationId?: string;
    pullRequest?: { url: string; headSha: string };
}

type ItemRow = typeof botInboxItems.$inferSelect;

const optionsSchema = z.array(z.string());

function toReply(row: typeof botInboxReplies.$inferSelect): BotInboxReply {
    return {
        sequence: row.sequence,
        body: row.body,
        source: botInboxReplySourceSchema.parse(row.source),
        createdAt: row.createdAt,
    };
}

function toItem(row: ItemRow, replies: BotInboxReply[]): StoredBotInboxItem {
    return {
        id: row.id,
        kind: botInboxKindSchema.parse(row.kind),
        status: botInboxStatusSchema.parse(row.status),
        ...(row.closeReason && {
            closeReason: botInboxCloseReasonSchema.parse(row.closeReason),
        }),
        ...(row.staleReason && {
            staleReason: botInboxStaleReasonSchema.parse(row.staleReason),
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
                    ...parseBotInboxPullRequestUrl(row.pullRequestUrl),
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
 * Storage for the Bot Inbox. Every mutation bumps `updated_at`. `revision` counts Caxri Bot's reports: only a new
 * report (insert or replace) or a close bumps it, in the same statement, so the owner's merge names the report they
 * read. A reply, an acknowledgement, or a stale mark leaves it alone, so none of them refuses that merge.
 */
export class BotInboxModel {
    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly transaction: <T>(work: () => T) => T,
    ) {}

    private repliesFor(itemIds: readonly string[]): Map<string, BotInboxReply[]> {
        const byItem = new Map<string, BotInboxReply[]>();
        if (itemIds.length === 0) return byItem;
        const rows = this.database
            .select()
            .from(botInboxReplies)
            .where(inArray(botInboxReplies.itemId, [...itemIds]))
            .orderBy(asc(botInboxReplies.itemId), asc(botInboxReplies.sequence))
            .all();
        for (const row of rows) {
            const replies = byItem.get(row.itemId) ?? [];
            replies.push(toReply(row));
            byItem.set(row.itemId, replies);
        }
        return byItem;
    }

    private withReplies(rows: readonly ItemRow[]): StoredBotInboxItem[] {
        const replies = this.repliesFor(rows.map((row) => row.id));
        return rows.map((row) => toItem(row, replies.get(row.id) ?? []));
    }

    private insertOpen(
        id: string,
        kind: BotInboxKind,
        key: string | undefined,
        values: BotInboxItemValues,
        now: number,
    ): StoredBotInboxItem {
        const openCount = this.database
            .select({ value: sql<number>`count(*)` })
            .from(botInboxItems)
            .where(eq(botInboxItems.status, 'open'))
            .get()!.value;
        if (openCount >= MAX_BOT_INBOX_OPEN_ITEMS)
            throw new CaxriError(
                'CAPACITY',
                `The Inbox already holds ${MAX_BOT_INBOX_OPEN_ITEMS} open items; resolve some first`,
            );
        this.database
            .insert(botInboxItems)
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
        source: BotInboxReplySource,
        now: number,
    ): number {
        const item = this.get(id);
        if (!item) throw new CaxriError('NOT_FOUND', 'Inbox item not found');
        if (item.status !== 'open') throw new CaxriError('CONFLICT', 'This Inbox item is closed');
        if (item.replies.length >= MAX_BOT_INBOX_REPLIES)
            throw new CaxriError(
                'CAPACITY',
                `An Inbox item holds at most ${MAX_BOT_INBOX_REPLIES} replies`,
            );
        const sequence = (item.replies.at(-1)?.sequence ?? 0) + 1;
        this.database
            .insert(botInboxReplies)
            .values({ itemId: id, sequence, body, source, createdAt: now })
            .run();
        this.database
            .update(botInboxItems)
            .set({ updatedAt: now })
            .where(eq(botInboxItems.id, id))
            .run();
        return sequence;
    }

    private closeOpen(id: string, reason: BotInboxCloseReason, now: number): boolean {
        const isChanged =
            this.database
                .update(botInboxItems)
                .set({
                    status: 'closed',
                    closeReason: reason,
                    revision: sql`${botInboxItems.revision} + 1`,
                    updatedAt: now,
                    closedAt: now,
                })
                .where(and(eq(botInboxItems.id, id), eq(botInboxItems.status, 'open')))
                .run().changes === 1;
        if (isChanged) this.pruneClosed();
        return isChanged;
    }

    private pruneClosed(): void {
        const retained = this.database
            .select({ id: botInboxItems.id })
            .from(botInboxItems)
            .where(eq(botInboxItems.status, 'closed'))
            .orderBy(desc(botInboxItems.closedAt))
            .limit(MAX_BOT_INBOX_CLOSED_ITEMS)
            .all()
            .map((row) => row.id);
        this.database
            .delete(botInboxItems)
            .where(
                and(
                    eq(botInboxItems.status, 'closed'),
                    retained.length > 0 ? notInArray(botInboxItems.id, retained) : sql`1 = 1`,
                ),
            )
            .run();
    }

    get(id: string): StoredBotInboxItem | undefined {
        const row = this.database
            .select()
            .from(botInboxItems)
            .where(eq(botInboxItems.id, id))
            .get();
        return row ? this.withReplies([row])[0] : undefined;
    }

    /**
     * Open items newest first, then, when asked, the most recently closed ones.
     */
    list(isClosedIncluded: boolean): StoredBotInboxItem[] {
        const open = this.database
            .select()
            .from(botInboxItems)
            .where(eq(botInboxItems.status, 'open'))
            .orderBy(desc(botInboxItems.updatedAt))
            .limit(MAX_BOT_INBOX_OPEN_ITEMS)
            .all();
        const closed = isClosedIncluded
            ? this.database
                  .select()
                  .from(botInboxItems)
                  .where(eq(botInboxItems.status, 'closed'))
                  .orderBy(desc(botInboxItems.closedAt))
                  .limit(MAX_BOT_INBOX_CLOSED_ITEMS)
                  .all()
            : [];
        return this.withReplies([...open, ...closed]);
    }

    findOpen(kind: BotInboxKind, key: string): StoredBotInboxItem | undefined {
        const row = this.database
            .select()
            .from(botInboxItems)
            .where(
                and(
                    eq(botInboxItems.status, 'open'),
                    eq(botInboxItems.kind, kind),
                    eq(botInboxItems.dedupKey, key),
                ),
            )
            .get();
        return row ? this.withReplies([row])[0] : undefined;
    }

    /**
     * Open `merge` items, whose pull requests the service reconciles against GitHub.
     */
    openMergeItems(): StoredBotInboxItem[] {
        const isOpenMerge = and(eq(botInboxItems.status, 'open'), eq(botInboxItems.kind, 'merge'));
        return this.withReplies(
            this.database.select().from(botInboxItems).where(isOpenMerge).all(),
        );
    }

    /**
     * Open items with a reply Caxri Bot has not acknowledged, with the highest unread sequence.
     */
    unacknowledged(): Array<{ id: string; sequence: number }> {
        return this.database
            .select({
                id: botInboxItems.id,
                sequence: sql<number>`max(${botInboxReplies.sequence})`,
            })
            .from(botInboxItems)
            .innerJoin(botInboxReplies, eq(botInboxReplies.itemId, botInboxItems.id))
            .where(eq(botInboxItems.status, 'open'))
            .groupBy(botInboxItems.id)
            .having(sql`max(${botInboxReplies.sequence}) > ${botInboxItems.acknowledgedSequence}`)
            .all();
    }

    insert(
        id: string,
        kind: BotInboxKind,
        key: string | undefined,
        values: BotInboxItemValues,
        now: number,
    ): StoredBotInboxItem {
        return this.transaction(() => this.insertOpen(id, kind, key, values, now));
    }

    /**
     * Replaces Caxri Bot-authored fields of an open item. A new report is new evidence, so it also clears a stale mark.
     */
    replace(id: string, values: BotInboxItemValues, now: number): StoredBotInboxItem {
        this.database
            .update(botInboxItems)
            .set({
                title: values.title,
                body: values.body,
                optionsJson: JSON.stringify(values.options),
                sessionId: values.sessionId ?? null,
                delegationId: values.delegationId ?? null,
                pullRequestUrl: values.pullRequest?.url ?? null,
                pullRequestHeadSha: values.pullRequest?.headSha ?? null,
                staleReason: null,
                revision: sql`${botInboxItems.revision} + 1`,
                updatedAt: now,
            })
            .where(and(eq(botInboxItems.id, id), eq(botInboxItems.status, 'open')))
            .run();
        return this.get(id)!;
    }

    setStale(id: string, reason: BotInboxStaleReason | undefined, now: number): boolean {
        return (
            this.database
                .update(botInboxItems)
                .set({ staleReason: reason ?? null, updatedAt: now })
                .where(
                    and(
                        eq(botInboxItems.id, id),
                        eq(botInboxItems.status, 'open'),
                        reason === undefined
                            ? sql`${botInboxItems.staleReason} IS NOT NULL`
                            : sql`${botInboxItems.staleReason} IS NOT ${reason}`,
                    ),
                )
                .run().changes === 1
        );
    }

    /**
     * Appends one reply and returns its sequence. Refuses a closed item, and an item that already holds the maximum
     * number of replies.
     */
    appendReply(id: string, body: string, source: BotInboxReplySource, now: number): number {
        return this.transaction(() => this.insertReply(id, body, source, now));
    }

    /**
     * Raises the acknowledged sequence; never lowers it, so a late, older acknowledgement changes nothing.
     */
    acknowledge(id: string, sequence: number, now: number): boolean {
        return (
            this.database
                .update(botInboxItems)
                .set({ acknowledgedSequence: sequence, updatedAt: now })
                .where(
                    and(
                        eq(botInboxItems.id, id),
                        sql`${botInboxItems.acknowledgedSequence} < ${sequence}`,
                    ),
                )
                .run().changes === 1
        );
    }

    counts(): { open: number; closed: number } {
        const rows = this.database
            .select({ status: botInboxItems.status, value: sql<number>`count(*)` })
            .from(botInboxItems)
            .groupBy(botInboxItems.status)
            .all();
        const count = (status: string) => rows.find((row) => row.status === status)?.value ?? 0;
        return { open: count('open'), closed: count('closed') };
    }

    /**
     * Deletes every item, open or closed, with its replies (the foreign key cascades), and returns the deleted IDs.
     */
    deleteAll(): string[] {
        return this.transaction(() => {
            const ids = this.database
                .select({ id: botInboxItems.id })
                .from(botInboxItems)
                .all()
                .map((row) => row.id);
            this.database.delete(botInboxItems).run();
            return ids;
        });
    }

    /**
     * Closes an open item and prunes the oldest closed items beyond the retained window. Returns false when the item
     * was not open.
     */
    close(id: string, reason: BotInboxCloseReason, now: number): boolean {
        return this.transaction(() => this.closeOpen(id, reason, now));
    }
}
