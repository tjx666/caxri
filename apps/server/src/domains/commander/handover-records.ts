import type { CommanderHandover } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

type HandoverDatabase = Pick<CaxriDatabase, 'getAppState' | 'setAppState'>;

/**
 * Every recorded hand-over. Records outlive their Session only until the next write, which drops the ones whose Session
 * was deleted.
 */
export function commanderHandovers(database: HandoverDatabase): CommanderHandover[] {
    return database.getAppState('commanderHandovers') ?? [];
}

export function writeCommanderHandovers(
    database: HandoverDatabase & Pick<CaxriDatabase, 'getSession'>,
    handovers: readonly CommanderHandover[],
): void {
    database.setAppState(
        'commanderHandovers',
        handovers.filter((handover) => database.getSession(handover.sessionId)),
    );
}

/**
 * The hand-over the Commander's first task in a Session continues. Refuses one that is gone (taken back, or typed into
 * by the user), belongs to another Session, has no conversation, or was already continued.
 */
export function pendingCommanderHandover(
    database: HandoverDatabase,
    handoverId: string,
    sessionId: string,
): CommanderHandover & { target: NonNullable<CommanderHandover['target']> } {
    const handover = commanderHandovers(database).find((entry) => entry.id === handoverId);
    if (!handover || handover.sessionId !== sessionId)
        throw new CaxriError(
            'NOT_FOUND',
            'Hand-over is unavailable; the user may have taken it back',
        );
    if (!handover.target)
        throw new CaxriError(
            'CONFLICT',
            'Hand-over gives ownership only; start a new task in the Session instead',
        );
    if (handover.firstDelegationId)
        throw new CaxriError(
            'CONFLICT',
            `Hand-over was already continued; follow up delegation ${handover.firstDelegationId}`,
        );
    return { ...handover, target: handover.target };
}

/**
 * Marks a hand-over continued by its first delegation, so it cannot start a second root task in the same conversation.
 */
export function consumeCommanderHandover(
    database: HandoverDatabase & Pick<CaxriDatabase, 'getSession'>,
    handoverId: string,
    delegationId: string,
): CommanderHandover | undefined {
    let consumed: CommanderHandover | undefined;
    const handovers = commanderHandovers(database).map((handover) => {
        if (handover.id !== handoverId) return handover;
        consumed = { ...handover, firstDelegationId: delegationId };
        return consumed;
    });
    if (consumed) writeCommanderHandovers(database, handovers);
    return consumed;
}
