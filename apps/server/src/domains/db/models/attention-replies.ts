import { and, eq, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { sessions } from '../schema';

function nextSessionActivityAt(now: number) {
    return sql<number>`MAX(${now}, COALESCE((SELECT MAX(${sessions.lastSessionActivityAt}) + 1 FROM ${sessions}), ${now}))`;
}

/**
 * Claims one exact waiting generation before a companion reply reaches the primary Agent PTY.
 */
export function didConsumeAttentionReply(
    database: CaxriDrizzleDatabase,
    id: string,
    terminalId: string,
    attentionEpoch: number,
): boolean {
    const now = Date.now();
    return (
        database
            .update(sessions)
            .set({
                lastActivityState: 'running',
                lastSessionActivityAt: nextSessionActivityAt(now),
                lastSessionActivityReason: 'user_submission',
            })
            .where(
                and(
                    eq(sessions.id, id),
                    eq(sessions.primaryAgentTerminalId, terminalId),
                    eq(sessions.lastActivityState, 'waiting'),
                    eq(sessions.attentionEpoch, attentionEpoch),
                ),
            )
            .run().changes === 1
    );
}

/**
 * Releases a claim only after the synchronous PTY write rejected it, before another event-loop turn can run.
 */
export function didReleaseAttentionReply(
    database: CaxriDrizzleDatabase,
    id: string,
    terminalId: string,
    attentionEpoch: number,
): boolean {
    return (
        database
            .update(sessions)
            .set({
                lastActivityState: 'waiting',
                lastSessionActivityReason: 'agent_waiting',
            })
            .where(
                and(
                    eq(sessions.id, id),
                    eq(sessions.primaryAgentTerminalId, terminalId),
                    eq(sessions.lastActivityState, 'running'),
                    eq(sessions.lastSessionActivityReason, 'user_submission'),
                    eq(sessions.attentionEpoch, attentionEpoch),
                ),
            )
            .run().changes === 1
    );
}
