import type { SessionRecord } from '@caxri/protocol';

/**
 * Where an Agent-created Session came from, as far as the Workbench can show it. `session` is a creating Session the
 * user can open; `archived` stays readable but is never restored by navigating to it; `commander` is the Agent
 * Commander's own hidden Session. A creator the Workbench cannot see (its Project is hidden) resolves to nothing, like
 * a Session the user created.
 */
export type SessionCreator =
    | { kind: 'session'; session: SessionRecord }
    | { kind: 'archived'; title: string }
    | { kind: 'commander' };

export function resolveSessionCreator(
    session: Pick<SessionRecord, 'createdBySessionId'>,
    sessions: readonly SessionRecord[],
    commanderSessionId: string | undefined,
): SessionCreator | undefined {
    const creatorId = session.createdBySessionId;
    if (!creatorId) return undefined;
    if (creatorId === commanderSessionId) return { kind: 'commander' };
    const creator = sessions.find((candidate) => candidate.id === creatorId);
    if (!creator) return undefined;
    return creator.archivedAt === undefined
        ? { kind: 'session', session: creator }
        : { kind: 'archived', title: creator.displayTitle };
}
