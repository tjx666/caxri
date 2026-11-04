import type { AgentChatDelegationNotice } from '@caxri/protocol';
import { agentChatDelegationNoticeSchema } from '@caxri/protocol';
import { and, eq, lt, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { delegationNoticeDeliveries } from '../schema';

/**
 * Most delivered notices kept per Terminal; the oldest are dropped past it. A notice that old has scrolled far out of
 * any Chat's recent history, and a replay that still holds it shows a plain message.
 */
export const MAX_NOTICE_DELIVERIES_PER_TERMINAL = 256;

/**
 * Pure persistence for the settlement notices written into a Chat, keyed by the digest of the delivered text. The
 * delegation domain decides when a notice is recorded; the Chat domain only asks whether a message is one.
 */
export class DelegationNoticeDeliveriesModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    private prune(terminalId: string): void {
        const cutoff = this.database
            .select({ createdAt: delegationNoticeDeliveries.createdAt })
            .from(delegationNoticeDeliveries)
            .where(eq(delegationNoticeDeliveries.terminalId, terminalId))
            .orderBy(sql`${delegationNoticeDeliveries.createdAt} DESC`)
            .limit(1)
            .offset(MAX_NOTICE_DELIVERIES_PER_TERMINAL)
            .get();
        if (!cutoff) return;
        this.database
            .delete(delegationNoticeDeliveries)
            .where(
                and(
                    eq(delegationNoticeDeliveries.terminalId, terminalId),
                    lt(delegationNoticeDeliveries.createdAt, cutoff.createdAt + 1),
                ),
            )
            .run();
    }

    /**
     * Records a notice about to be written to `terminalId`. A repeat of the same text on the Terminal keeps the first
     * row. The Terminal may be gone; its foreign key then rejects the insert, which is ignored. Returns whether this
     * call stored the row, so a caller whose write is refused removes only what it stored.
     */
    record(
        terminalId: string,
        digest: string,
        notice: AgentChatDelegationNotice,
        now: number,
    ): boolean {
        let isStored: boolean;
        try {
            isStored =
                this.database
                    .insert(delegationNoticeDeliveries)
                    .values({
                        terminalId,
                        digest,
                        itemsJson: JSON.stringify(notice),
                        createdAt: now,
                    })
                    .onConflictDoNothing()
                    .run().changes === 1;
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('FOREIGN KEY')) throw error;
            return false;
        }
        this.prune(terminalId);
        return isStored;
    }

    /**
     * The notice delivered to `terminalId` whose text has this digest, or undefined when none was (or its row no longer
     * parses).
     */
    delivered(terminalId: string, digest: string): AgentChatDelegationNotice | undefined {
        const row = this.database
            .select({ itemsJson: delegationNoticeDeliveries.itemsJson })
            .from(delegationNoticeDeliveries)
            .where(
                and(
                    eq(delegationNoticeDeliveries.terminalId, terminalId),
                    eq(delegationNoticeDeliveries.digest, digest),
                ),
            )
            .get();
        if (!row) return undefined;
        try {
            const parsed = agentChatDelegationNoticeSchema.safeParse(JSON.parse(row.itemsJson));
            return parsed.success ? parsed.data : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Forgets a record whose write was refused before anything reached the Chat.
     */
    remove(terminalId: string, digest: string): void {
        this.database
            .delete(delegationNoticeDeliveries)
            .where(
                and(
                    eq(delegationNoticeDeliveries.terminalId, terminalId),
                    eq(delegationNoticeDeliveries.digest, digest),
                ),
            )
            .run();
    }
}
