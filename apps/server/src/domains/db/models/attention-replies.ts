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
    attentionGeneration: number,
): boolean {
    return (
        database
            .update(sessions)
            .set({
                agentActivityState: 'running',
            })
            .where(
                and(
                    eq(sessions.id, id),
                    eq(sessions.primaryAgentTerminalId, terminalId),
                    eq(sessions.agentActivityState, 'waiting'),
                    eq(sessions.attentionGeneration, attentionGeneration),
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
    attentionGeneration: number,
    activityAt: number,
): boolean {
    return (
        database
            .update(sessions)
            .set({
                agentActivityState: 'waiting',
            })
            .where(
                and(
                    eq(sessions.id, id),
                    eq(sessions.primaryAgentTerminalId, terminalId),
                    eq(sessions.agentActivityState, 'running'),
                    eq(sessions.sessionActivityAt, activityAt),
                    eq(sessions.attentionGeneration, attentionGeneration),
                ),
            )
            .run().changes === 1
    );
}
