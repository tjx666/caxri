import type { BotHandover, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { CaxriError, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';

type HandoverDatabase = Pick<CaxriDatabase, 'getAppState' | 'setAppState'>;

/**
 * Every recorded hand-over. Records outlive their Session only until the next write, which drops the ones whose Session
 * was deleted.
 */
export function botHandovers(database: HandoverDatabase): BotHandover[] {
    return database.getAppState('botHandovers') ?? [];
}

export function writeBotHandovers(
    database: HandoverDatabase & Pick<CaxriDatabase, 'getSession'>,
    handovers: readonly BotHandover[],
): void {
    database.setAppState(
        'botHandovers',
        handovers.filter((handover) => database.getSession(handover.sessionId)),
    );
}

/**
 * The hand-over Caxri Bot's first task in a Session continues. Refuses one that is gone (taken back, or typed into by
 * the user), belongs to another Session, has no conversation, or was already continued.
 */
function pendingBotHandover(
    database: HandoverDatabase,
    handoverId: string,
    sessionId: string,
): BotHandover & { target: NonNullable<BotHandover['target']> } {
    const handover = botHandovers(database).find((entry) => entry.id === handoverId);
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
function consumeBotHandover(
    database: HandoverDatabase & Pick<CaxriDatabase, 'getSession'>,
    handoverId: string,
    delegationId: string,
): BotHandover | undefined {
    let consumed: BotHandover | undefined;
    const handovers = botHandovers(database).map((handover) => {
        if (handover.id !== handoverId) return handover;
        consumed = { ...handover, firstDelegationId: delegationId };
        return consumed;
    });
    if (consumed) writeBotHandovers(database, handovers);
    return consumed;
}

/**
 * True while the Agent is in a turn or waiting on the user. A continuation then would cut the turn off, so the Caxri
 * Bot waits for the `ready` notice instead.
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
 * The delegation service's view of hand-overs, for Caxri Bot's `--continue-handover` task.
 */
export function botHandoverAccess(
    database: CaxriDatabase,
    logger?: StructuredLogger,
    now: () => number = Date.now,
) {
    return {
        target: (handoverId: string, sessionId: string) =>
            pendingBotHandover(database, handoverId, sessionId).target,
        isBusy: (sessionId: string, terminalId: string) =>
            isHandoverTargetBusy(database.getSession(sessionId), database.getTerminal(terminalId)),
        /**
         * Links the hand-over's task to the delegation, as `bot task update --delegation` would, so the ledger never
         * records a second task for the new root delegation.
         */
        consume: (handoverId: string, delegationId: string) => {
            const handover = consumeBotHandover(database, handoverId, delegationId);
            if (!handover) return;
            const task = handover.taskId ? database.botTasks.get(handover.taskId) : undefined;
            if (task)
                database.botTasks.update(
                    task.id,
                    {
                        delegationId,
                        ...(task.status === 'pending' && { status: 'dispatched' }),
                    },
                    now(),
                );
            logger?.write('info', logEventCatalog.caxriBot.handoverContinued, {
                fields: {
                    handoverId,
                    delegationId,
                    source: handover.source,
                    waitMs: Math.max(0, now() - handover.createdAt),
                },
            });
        },
        /**
         * Clears the consumption only while this delegation still holds it; the task stays linked until Caxri Bot's
         * retry links its new delegation.
         */
        release: (handoverId: string, delegationId: string) => {
            const handovers = botHandovers(database);
            if (handovers.every((entry) => entry.firstDelegationId !== delegationId)) return;
            writeBotHandovers(
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
