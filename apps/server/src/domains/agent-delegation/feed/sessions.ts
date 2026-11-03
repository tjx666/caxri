import type {
    AgentDelegationReceipt,
    AgentDelegationSession,
    AgentDelegationStatusEntry,
} from '@caxri/protocol';
import { isDelegationActive, MAX_DELEGATION_SESSIONS } from '@caxri/protocol';

import type { CaxriDatabase } from '../../db';

/**
 * What the Sessions read borrows from the delegation service.
 */
export interface DelegationSessionsSource {
    database: CaxriDatabase;
    /**
     * The step an active Chat Session is on; see `AgentDelegationServiceOptions.chatStep`.
     */
    chatStep?(terminalId: string): string | undefined;
}

/**
 * How well a receipt describes its Session's state, highest first: a task still in flight, then any task that ran, then
 * a follow-up or resume the Server refused because another task holds the Session (`target_busy`) or because the
 * Session was not ready for it (`target_not_ready`).
 *
 * A `target_busy` or `target_not_ready` refusal is persisted as a new `failed` receipt with the latest creation time,
 * yet it never ran: the task that holds the Session (running, or the earlier follow-up that took the chain) is another
 * receipt of the same Session. Ranking by creation alone would report a Session whose task is still running as failed
 * and drop its step.
 */
function stateRank(receipt: AgentDelegationReceipt): number {
    if (isDelegationActive(receipt)) return 2;
    return receipt.failure === 'target_busy' || receipt.failure === 'target_not_ready' ? 0 : 1;
}

/**
 * The receipt that stands for each Session: the best {@link stateRank}, the newest by creation among equals.
 */
function stateReceipts(receipts: readonly AgentDelegationReceipt[]) {
    const chosen = new Map<string, AgentDelegationReceipt>();
    for (const receipt of receipts) {
        const known = chosen.get(receipt.sessionId);
        const isBetter =
            !known ||
            stateRank(receipt) > stateRank(known) ||
            (stateRank(receipt) === stateRank(known) && receipt.createdAt > known.createdAt);
        if (isBetter) chosen.set(receipt.sessionId, receipt);
    }
    return chosen;
}

/**
 * `agent.delegation.sessions`: the Sessions the named Sessions created (delegated, handed off, or consulted), each with
 * the state of its newest task (see {@link stateRank} for which receipt that is) and the stored result of its latest
 * completed one. The result names the task that produced it (`delegationId`, `completedAt`), so a Client can tell
 * whether it belongs to the newest task or to an earlier one. Newest Session first, at most
 * {@link MAX_DELEGATION_SESSIONS}.
 *
 * It is a read for the owner's Delegated Sessions feed and claims nothing: the answer stays unread for the caller that
 * delegated the task, and nothing here carries the answer text, only the stored summary.
 */
export function delegationSessions(
    source: DelegationSessionsSource,
    createdBySessionIds: readonly string[],
): AgentDelegationSession[] {
    const { database } = source;
    const created = database.createdSessions.list(createdBySessionIds, MAX_DELEGATION_SESSIONS);
    const sessionIds = created.map((session) => session.sessionId);
    const receipts = stateReceipts(database.agentDelegations.receiptsForSessions(sessionIds));
    const results = database.createdSessions.results(sessionIds);
    const takeovers = database.agentDelegations.takeoversForSessions(sessionIds);
    return created.map(({ sessionId, createdBySessionId, relation }) => {
        const receipt = receipts.get(sessionId);
        const result = results.get(sessionId);
        const takenOverAt = takeovers.get(sessionId);
        const step =
            receipt?.terminalId && isDelegationActive(receipt)
                ? source.chatStep?.(receipt.terminalId)
                : undefined;
        return {
            sessionId,
            createdBySessionId,
            relation,
            ...(receipt && {
                delegationId: receipt.delegationId,
                provider: receipt.provider,
                status: receipt.status,
                createdAt: receipt.createdAt,
                ...(receipt.failure && { failure: receipt.failure }),
                ...(receipt.failureResetsAt !== undefined && {
                    failureResetsAt: receipt.failureResetsAt,
                }),
                ...(receipt.settledAt !== undefined && { settledAt: receipt.settledAt }),
            }),
            ...(takenOverAt !== undefined && { takenOverAt }),
            ...(step && { step }),
            ...(result && {
                result: {
                    summary: result.summary,
                    source: result.source,
                    delegationId: result.delegationId,
                    completedAt: result.completedAt,
                },
            }),
        };
    });
}

/**
 * `agent.delegation.statuses`: the state of each named task, by task ID, in the order named. A pruned or unknown ID is
 * left out. It reads receipts only, so it carries no answer and claims nothing.
 */
export function delegationStatuses(
    source: Pick<DelegationSessionsSource, 'database'>,
    delegationIds: readonly string[],
): AgentDelegationStatusEntry[] {
    const byId = new Map(
        source.database.agentDelegations
            .receiptsByIds(delegationIds)
            .map((receipt) => [receipt.delegationId, receipt]),
    );
    return [...new Set(delegationIds)].flatMap((delegationId) => {
        const receipt = byId.get(delegationId);
        if (!receipt) return [];
        return [
            {
                delegationId,
                sessionId: receipt.sessionId,
                provider: receipt.provider,
                status: receipt.status,
                ...(receipt.failure && { failure: receipt.failure }),
                ...(receipt.failureResetsAt !== undefined && {
                    failureResetsAt: receipt.failureResetsAt,
                }),
                ...(receipt.settledAt !== undefined && { settledAt: receipt.settledAt }),
            },
        ];
    });
}
