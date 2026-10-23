import type { SessionRecord } from '@caxri/protocol';

/**
 * The Session a `/new-session` message sent at `sentAt` handed off to: the first Session the Agent of `sourceSessionId`
 * created from then on. The hand-off delegation does not record which message asked for it, so this is the closest fact
 * the Workbench holds; the instructions ask for exactly one Session, so the first one after the message is it.
 * `undefined` until the Agent has created it, and for a message whose send time is unknown (history the provider kept
 * no time for).
 */
export function agentChatSessionHandoffTarget<
    Session extends Pick<SessionRecord, 'createdAt' | 'createdBySessionId'>,
>(
    sessions: readonly Session[] | undefined,
    sourceSessionId: string | undefined,
    sentAt: number | undefined,
): Session | undefined {
    if (!sessions || sourceSessionId === undefined || sentAt === undefined) return undefined;
    let target: Session | undefined;
    for (const session of sessions) {
        if (session.createdBySessionId !== sourceSessionId || session.createdAt < sentAt) continue;
        if (!target || session.createdAt < target.createdAt) target = session;
    }
    return target;
}
