import type { DelegationControl, DelegationControlChange } from '@caxri/protocol';
import { MAX_DELEGATION_CONTROL_CHANGES } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation, StoredDelegationHandBack } from '../../db';

/**
 * Who each named Session answers to now, for the Sessions that have ever been taken over or handed back; any other
 * Session is absent and reads as `delegated`.
 *
 * - `handback_pending` while a grant is pending.
 * - `human` after a takeover, until a hand-back's follow-up created a newer task that the user has not taken over again.
 *   The old tasks keep their takeover mark for good, so the answer comes from the task that used the latest grant: if
 *   it is gone (pruned) or marked, the user is in control.
 *
 * `takeovers` and `grants` are the Sessions' takeovers and hand-back grants when the caller already read them (see
 * `AgentDelegationsModel.receiptsAndTakeoversForSessions` and {@link sessionGrants}), so nothing is read twice.
 */
export function sessionControls(
    database: Pick<CaxriDatabase, 'agentDelegations'>,
    sessionIds: readonly string[],
    takeovers?: ReadonlyMap<string, number>,
    grants: ReadonlyMap<string, StoredDelegationHandBack[]> = sessionGrants(database, sessionIds),
): Map<string, DelegationControl> {
    const controls = new Map<string, DelegationControl>();
    if (sessionIds.length === 0) return controls;
    const { agentDelegations } = database;
    for (const sessionId of sessionIds) {
        const mine = grants.get(sessionId) ?? [];
        if (mine.some((grant) => grant.state === 'pending')) {
            controls.set(sessionId, 'handback_pending');
            continue;
        }
        const used = mine.findLast((grant) => grant.state === 'consumed');
        const successor = used?.consumedBy && agentDelegations.get(used.consumedBy);
        if (successor && !successor.hasHumanIntervention) controls.set(sessionId, 'delegated');
    }
    // A Session never taken over has no mark on any task, so it is not `human`.
    const taken = takeovers ?? agentDelegations.takeoversForSessions(sessionIds);
    for (const sessionId of sessionIds) {
        const known = controls.get(sessionId);
        if (known === undefined && taken.has(sessionId)) controls.set(sessionId, 'human');
    }
    return controls;
}

/**
 * The task a hand-back continues: the Session's newest task that ran in a Terminal launch. A refused follow-up is also
 * stored, as a failed task with no launch, and must not be mistaken for the task the child actually ran.
 */
export function handBackAnchor(
    database: Pick<CaxriDatabase, 'agentDelegations'>,
    sessionId: string,
): StoredAgentDelegation | undefined {
    return database.agentDelegations
        .forSession(sessionId)
        .filter((task) => task.receipt.terminalId && task.launchId && task.providerSessionId)
        .toSorted((a, b) => b.receipt.createdAt - a.receipt.createdAt)[0];
}

/**
 * The named Sessions' hand-back grants in any state, oldest first, grouped by Session.
 */
export function sessionGrants(
    database: Pick<CaxriDatabase, 'agentDelegations'>,
    sessionIds: readonly string[],
): Map<string, StoredDelegationHandBack[]> {
    return Map.groupBy(
        database.agentDelegations.handBacks.forSessions(sessionIds),
        (grant) => grant.sessionId,
    );
}

/**
 * When one Session changed hands, oldest first and capped to the newest {@link MAX_DELEGATION_CONTROL_CHANGES}: each
 * task's takeover and each hand-back the user did not take back. An `invalidated` grant is left out, since the user
 * kept the Session; a `pending` one is in, since the Session already waits on the delegating Agent. `undefined` when
 * nothing changed hands.
 */
export function controlChanges(
    takeoverTimes: readonly number[] | undefined,
    grants: readonly StoredDelegationHandBack[] | undefined,
): DelegationControlChange[] | undefined {
    const changes: DelegationControlChange[] = [
        ...(takeoverTimes ?? []).map((at) => ({ kind: 'taken_over' as const, at })),
        ...(grants ?? [])
            .filter((grant) => grant.state !== 'invalidated')
            .map((grant) => ({
                kind: 'handed_back' as const,
                at: grant.createdAt,
                trigger: grant.trigger,
            })),
    ];
    if (changes.length === 0) return undefined;
    return changes.toSorted((a, b) => a.at - b.at).slice(-MAX_DELEGATION_CONTROL_CHANGES);
}
