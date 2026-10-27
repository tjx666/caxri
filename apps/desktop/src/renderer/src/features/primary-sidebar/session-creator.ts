import type { SessionRecord } from '@caxri/protocol';

/**
 * Where an Agent-created Session came from, as far as the Workbench can show it. `session` is a creating Session the
 * user can open; `archived` stays readable but is never restored by navigating to it; `bot` is the Agent Caxri Bot's
 * own hidden Session. A creator the Workbench cannot see (its Project is hidden) resolves to nothing, like a Session
 * the user created.
 */
export type SessionCreator =
    | { kind: 'session'; session: SessionRecord }
    | { kind: 'archived'; title: string }
    | { kind: 'bot' };

export function resolveSessionCreator(
    session: Pick<SessionRecord, 'createdBySessionId'>,
    sessions: readonly SessionRecord[],
    botSessionId: string | undefined,
): SessionCreator | undefined {
    const creatorId = session.createdBySessionId;
    if (!creatorId) return undefined;
    if (creatorId === botSessionId) return { kind: 'bot' };
    const creator = sessions.find((candidate) => candidate.id === creatorId);
    if (!creator) return undefined;
    return creator.archivedAt === undefined
        ? { kind: 'session', session: creator }
        : { kind: 'archived', title: creator.title };
}
