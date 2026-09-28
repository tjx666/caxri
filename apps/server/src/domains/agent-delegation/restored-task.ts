import { isDelegationActive } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation } from '../db';

/**
 * The settled task a resumed launch of this Terminal continues: the newest link of its task chain, bound to the
 * conversation the Terminal is resuming, never taken over or retargeted. See `AgentDelegationService.bindEnvironment`.
 */
export function restoredDelegationFor(
    database: CaxriDatabase,
    terminalId: string,
): StoredAgentDelegation | undefined {
    const agentSessionId = database.getTerminal(terminalId)?.agentSessionId;
    if (!agentSessionId) return undefined;
    const tasks = database.agentDelegations.forTerminal(terminalId);
    if (tasks.some((task) => isDelegationActive(task.receipt))) return undefined;
    const newest = tasks.reduce<StoredAgentDelegation | undefined>(
        (latest, task) =>
            !latest || task.receipt.createdAt > latest.receipt.createdAt ? task : latest,
        undefined,
    );
    return newest &&
        !newest.nextDelegationId &&
        !newest.hasLostTarget &&
        !newest.hasHumanIntervention &&
        newest.providerSessionId === agentSessionId
        ? newest
        : undefined;
}
