import type { CommanderHandover, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { CaxriError, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

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
function pendingCommanderHandover(
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
function consumeCommanderHandover(
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

/**
 * True while the Agent is in a turn or waiting on the user. A continuation then would cut the turn off, so the
 * Commander waits for the `ready` notice instead.
 */
export function isHandoverTargetBusy(
    session: SessionRecord | undefined,
    terminal: TerminalRecord | undefined,
): boolean {
    return (
        terminal?.lastAgentProcessState === 'running' &&
        (session?.lastActivityState === 'running' || session?.lastActivityState === 'waiting')
    );
}

/**
 * The delegation service's view of hand-overs, for the Commander's `--continue-handover` task.
 */
export function commanderHandoverAccess(
    database: CaxriDatabase,
    logger?: StructuredLogger,
    now: () => number = Date.now,
) {
    return {
        target: (handoverId: string, sessionId: string) =>
            pendingCommanderHandover(database, handoverId, sessionId).target,
        isBusy: (sessionId: string, terminalId: string) =>
            isHandoverTargetBusy(database.getSession(sessionId), database.getTerminal(terminalId)),
        /**
         * Links the hand-over's task to the delegation, as `commander task update --delegation` would, so the ledger
         * never records a second task for the new root delegation.
         */
        consume: (handoverId: string, delegationId: string) => {
            const handover = consumeCommanderHandover(database, handoverId, delegationId);
            if (!handover) return;
            const task = handover.taskId ? database.commanderTasks.get(handover.taskId) : undefined;
            if (task)
                database.commanderTasks.update(
                    task.id,
                    {
                        delegationId,
                        ...(task.status === 'pending' && { status: 'dispatched' }),
                    },
                    now(),
                );
            logger?.write('info', logEventCatalog.agentCommander.handoverContinued, {
                fields: {
                    handoverId,
                    delegationId,
                    source: handover.source,
                    waitMs: Math.max(0, now() - handover.createdAt),
                },
            });
        },
        /**
         * Clears the consumption only while this delegation still holds it; the task stays linked until the Commander's
         * retry links its new delegation.
         */
        release: (handoverId: string, delegationId: string) => {
            const handovers = commanderHandovers(database);
            if (handovers.every((entry) => entry.firstDelegationId !== delegationId)) return;
            writeCommanderHandovers(
                database,
                handovers.map((entry) =>
                    entry.id === handoverId && entry.firstDelegationId === delegationId
                        ? { ...entry, firstDelegationId: undefined }
                        : entry,
                ),
            );
        },
    };
}
