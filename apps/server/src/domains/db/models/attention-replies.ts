import { and, eq } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { sessions } from '../schema';

/**
 * Claims one exact waiting generation without manufacturing activity before the Agent PTY accepts the reply.
 */
export function didConsumeAttentionReply(
    database: CaxriDrizzleDatabase,
    id: string,
    terminalId: string,
    attentionEpoch: number,
): boolean {
    return (
        database
            .update(sessions)
            .set({
                lastActivityState: 'running',
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
 * Releases a failed asynchronous write only while no newer activity or attention generation has superseded its claim.
 */
export function didReleaseAttentionReply(
    database: CaxriDrizzleDatabase,
    id: string,
    terminalId: string,
    attentionEpoch: number,
    activityAt: number,
): boolean {
    return (
        database
            .update(sessions)
            .set({
                lastActivityState: 'waiting',
            })
            .where(
                and(
                    eq(sessions.id, id),
                    eq(sessions.primaryAgentTerminalId, terminalId),
                    eq(sessions.lastActivityState, 'running'),
                    eq(sessions.lastSessionActivityAt, activityAt),
                    eq(sessions.attentionEpoch, attentionEpoch),
                ),
            )
            .run().changes === 1
    );
}
