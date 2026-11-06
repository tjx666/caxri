import type {
    AgentDelegationReceipt,
    AgentDelegationSession,
    AgentDelegationStatusEntry,
    DelegationApprovalSummary,
    DelegationWaitingOn,
} from '@caxri/protocol';
import { isDelegationActive, MAX_DELEGATION_SESSIONS } from '@caxri/protocol';

import type { CaxriDatabase } from '../../db';
import { sessionControls } from '../handback/control';
import { questionSummaries } from '../questions/summary';

/**
 * What the Sessions read borrows from the delegation service.
 */
export interface DelegationSessionsSource {
    database: CaxriDatabase;
    /**
     * The step an active Chat Session is on; see `AgentDelegationServiceOptions.chatStep`.
     */
    chatStep?(terminalId: string): string | undefined;
    /**
     * The pending approval of each named task, and whom the task then waits on; see `DelegationApprovals.feed`.
     */
    approvals?: {
        feed(
            delegationIds: readonly string[],
        ): Map<string, { approval: DelegationApprovalSummary; waitingOn: DelegationWaitingOn }>;
    };
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
    return delegationEntries(
        source,
        source.database.createdSessions.list(createdBySessionIds, MAX_DELEGATION_SESSIONS),
    );
}

/**
 * The feed entry of each named Session, in the order given: the same entry {@link delegationSessions} builds, for
 * Sessions the caller already found by another route (the tree-wide attention read walks edges, not creators).
 * `isSummary: false` leaves out the `step` and the stored `result`, which a reader that only classifies the Session
 * does not draw, so it skips their lookups.
 */
export function delegationEntries(
    source: DelegationSessionsSource,
    created: ReadonlyArray<
        Pick<AgentDelegationSession, 'createdBySessionId' | 'relation' | 'sessionId'>
    >,
    { isSummary = true }: { isSummary?: boolean } = {},
): AgentDelegationSession[] {
    const { database } = source;
    const sessionIds = created.map((session) => session.sessionId);
    // One read and parse of the Sessions' records feeds the receipts, the takeovers and the controls.
    const { receipts: allReceipts, takeovers } =
        database.agentDelegations.receiptsAndTakeoversForSessions(sessionIds);
    const receipts = stateReceipts(allReceipts);
    const results = isSummary ? database.createdSessions.results(sessionIds) : undefined;
    const controls = sessionControls(database, sessionIds, takeovers);
    const delegationIds = receipts
        .values()
        .map((receipt) => receipt.delegationId)
        .toArray();
    const questions = questionSummaries(database, delegationIds);
    const approvals = source.approvals?.feed(delegationIds);
    return created.map(({ sessionId, createdBySessionId, relation }) => {
        const receipt = receipts.get(sessionId);
        const result = results?.get(sessionId);
        const takenOverAt = takeovers.get(sessionId);
        const question = receipt && questions.get(receipt.delegationId);
        const approval = receipt && approvals?.get(receipt.delegationId);
        const step =
            isSummary && receipt?.terminalId && isDelegationActive(receipt)
                ? source.chatStep?.(receipt.terminalId)
                : undefined;
        return {
            sessionId,
            createdBySessionId,
            relation,
            ...(receipt && {
                delegationId: receipt.delegationId,
                provider: receipt.provider,
                ...(receipt.selection && { selection: receipt.selection }),
                status: receipt.status,
                createdAt: receipt.createdAt,
                ...(receipt.failure && { failure: receipt.failure }),
                ...(receipt.failureResetsAt !== undefined && {
                    failureResetsAt: receipt.failureResetsAt,
                }),
                ...(receipt.settledAt !== undefined && { settledAt: receipt.settledAt }),
                ...(receipt.retryOf && { retryOf: receipt.retryOf }),
                ...(receipt.retriedAs && { retriedAs: receipt.retriedAs }),
                ...(receipt.retryScheduledFor !== undefined && {
                    retryScheduledFor: receipt.retryScheduledFor,
                }),
                ...(receipt.retryScheduleOutcome && {
                    retryScheduleOutcome: receipt.retryScheduleOutcome,
                }),
            }),
            ...(takenOverAt !== undefined && { takenOverAt }),
            ...(controls.has(sessionId) && { control: controls.get(sessionId) }),
            ...(approval && { approval: approval.approval, waitingOn: approval.waitingOn }),
            ...question,
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
    source: Pick<DelegationSessionsSource, 'database' | 'approvals'>,
    delegationIds: readonly string[],
): AgentDelegationStatusEntry[] {
    const byId = new Map(
        source.database.agentDelegations
            .receiptsByIds(delegationIds)
            .map((receipt) => [receipt.delegationId, receipt]),
    );
    const questions = questionSummaries(source.database, byId.keys().toArray());
    const approvals = source.approvals?.feed(byId.keys().toArray());
    return [...new Set(delegationIds)].flatMap((delegationId) => {
        const receipt = byId.get(delegationId);
        if (!receipt) return [];
        return [
            {
                ...(approvals?.has(delegationId) && {
                    approval: approvals.get(delegationId)!.approval,
                    waitingOn: approvals.get(delegationId)!.waitingOn,
                }),
                ...questions.get(delegationId),
                delegationId,
                sessionId: receipt.sessionId,
                provider: receipt.provider,
                status: receipt.status,
                ...(receipt.failure && { failure: receipt.failure }),
                ...(receipt.failureResetsAt !== undefined && {
                    failureResetsAt: receipt.failureResetsAt,
                }),
                ...(receipt.settledAt !== undefined && { settledAt: receipt.settledAt }),
                ...(receipt.retryOf && { retryOf: receipt.retryOf }),
                ...(receipt.retriedAs && { retriedAs: receipt.retriedAs }),
                ...(receipt.retryScheduledFor !== undefined && {
                    retryScheduledFor: receipt.retryScheduledFor,
                }),
                ...(receipt.retryScheduleOutcome && {
                    retryScheduleOutcome: receipt.retryScheduleOutcome,
                }),
            },
        ];
    });
}
