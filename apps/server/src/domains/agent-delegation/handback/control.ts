import type { DelegationControl } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation } from '../../db';

/**
 * Who each named Session answers to now, for the Sessions that have ever been taken over or handed back; any other
 * Session is absent and reads as `delegated`.
 *
 * - `handback_pending` while a grant is pending.
 * - `human` after a takeover, until a hand-back's follow-up created a newer task that the user has not taken over again.
 *   The old tasks keep their takeover mark for good, so the answer comes from the task that used the latest grant: if
 *   it is gone (pruned) or marked, the user is in control.
 *
 * `takeovers` is the Sessions' takeovers when the caller already read them (see
 * `AgentDelegationsModel.receiptsAndTakeoversForSessions`), so the records are not parsed again.
 */
export function sessionControls(
    database: Pick<CaxriDatabase, 'agentDelegations'>,
    sessionIds: readonly string[],
    takeovers?: ReadonlyMap<string, number>,
): Map<string, DelegationControl> {
    const controls = new Map<string, DelegationControl>();
    if (sessionIds.length === 0) return controls;
    const { agentDelegations } = database;
    const grants = Map.groupBy(
        agentDelegations.handBacks.forSessions(sessionIds),
        (g) => g.sessionId,
    );
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
