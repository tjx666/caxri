import type { AgentChatItem } from '@caxri/protocol';
import { agentChatItemSchema } from '@caxri/protocol';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { agentChatAnsweredNotices } from '../schema';

/**
 * An `answered` notice item with the item it followed, the anchor a history replay re-inserts it after.
 */
export interface StoredAnsweredNotice {
    notice: AgentChatItem;
    after: string | undefined;
}

/**
 * Pure CRUD for the `Answered: ...` notices Server Core recorded in a Chat, which no provider history can rebuild. The
 * Agent Chat domain decides when a notice is saved and when a replay drops it.
 */
export class AgentChatAnsweredNoticesModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Oldest first. A row that no longer parses (written by an older build) is skipped rather than failing the Chat.
     */
    list(terminalId: string): StoredAnsweredNotice[] {
        return this.database
            .select()
            .from(agentChatAnsweredNotices)
            .where(eq(agentChatAnsweredNotices.terminalId, terminalId))
            .orderBy(asc(agentChatAnsweredNotices.createdAt), asc(agentChatAnsweredNotices.itemId))
            .all()
            .flatMap((row) => {
                let json: unknown;
                try {
                    json = JSON.parse(row.itemJson);
                } catch {
                    return [];
                }
                const parsed = agentChatItemSchema.safeParse(json);
                return parsed.success
                    ? [{ notice: parsed.data, after: row.afterItemId ?? undefined }]
                    : [];
            });
    }

    /**
     * Saves one notice. The Terminal may be gone by the time a late answer lands; its foreign key then rejects the
     * insert, which is ignored because there is no Chat left to restore it in.
     */
    save(
        terminalId: string,
        notice: AgentChatItem,
        after: string | undefined,
        now = Date.now(),
    ): void {
        if (notice.turnId === undefined) return;
        try {
            this.database
                .insert(agentChatAnsweredNotices)
                .values({
                    terminalId,
                    itemId: notice.id,
                    turnId: notice.turnId,
                    afterItemId: after ?? null,
                    itemJson: JSON.stringify(notice),
                    createdAt: now,
                })
                .onConflictDoNothing()
                .run();
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('FOREIGN KEY')) throw error;
        }
    }

    remove(terminalId: string, itemIds: readonly string[]): void {
        if (itemIds.length === 0) return;
        this.database
            .delete(agentChatAnsweredNotices)
            .where(
                and(
                    eq(agentChatAnsweredNotices.terminalId, terminalId),
                    inArray(agentChatAnsweredNotices.itemId, [...itemIds]),
                ),
            )
            .run();
    }
}
