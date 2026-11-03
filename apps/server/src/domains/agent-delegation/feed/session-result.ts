import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase, StoredAgentDelegation } from '../../db';
import { logDelegationResult } from '../diagnostics';
import { delegationResultSummary } from './result-summary';

/**
 * Whether a save moved the task into `completed` with an answer, the moment its Session's result is (re)written. A
 * later save of the same completed task (a claimed answer, a bookkeeping offset) does not rewrite it.
 */
export function isNewlyCompleted(
    saved: Pick<StoredAgentDelegation, 'answer' | 'receipt'>,
    before: Pick<StoredAgentDelegation, 'answer' | 'receipt'> | undefined,
): boolean {
    return (
        saved.receipt.status === 'completed' &&
        saved.answer !== undefined &&
        (before?.receipt.status !== 'completed' ||
            before.answer?.messageId !== saved.answer.messageId)
    );
}

/**
 * Whether the tasks of `sessionId` report a result: the Session was created by another Session's delegation or consult,
 * which is what the Delegated Sessions feed lists. A hand-off, an ordinary Session, and a Session Caxri Bot or the
 * owner created have no creator relation of this kind. Both the Summary instruction a task carries
 * (`delegationTaskBody`) and the result stored when it completes (`recordDelegationResult`) follow this one condition.
 */
export function shouldReportDelegationResult(
    database: Pick<CaxriDatabase, 'getSession'>,
    sessionId: string,
): boolean {
    const relation = database.getSession(sessionId)?.createdByRelation;
    return relation === 'delegated' || relation === 'consult';
}

/**
 * Stores the one-line result of a task that completed in a Session another Session delegated to or consulted, for the
 * Delegated Sessions feed. A later task of the same Session replaces it, and so does a later task whose answer has no
 * text to summarize: the row is deleted rather than kept, because an older task's summary beside a newer task's status
 * would read as the newer task's result. A Session that is not a delegated or consulted one (a hand-off, an ordinary
 * Session, Caxri Bot's own) stores nothing.
 *
 * The row lives beside the task record, not in it, so it outlives the 1024-record pruning of tasks and the Session's
 * archival (only deleting the Session removes it). It holds a clipped summary of the answer, never the answer, and is
 * private domain data: it is read only by the owner-only `agent.delegation.sessions` method.
 */
export function recordDelegationResult(
    database: Pick<CaxriDatabase, 'createdSessions' | 'getSession'>,
    saved: Pick<StoredAgentDelegation, 'answer' | 'receipt'>,
    logger?: StructuredLogger,
): void {
    const { receipt, answer } = saved;
    if (!shouldReportDelegationResult(database, receipt.sessionId)) return;
    const summary = answer && delegationResultSummary(answer.text);
    if (!summary) {
        database.createdSessions.deleteResult(receipt.sessionId);
        logDelegationResult(logger, receipt, { outcome: 'no_summary' });
        return;
    }
    database.createdSessions.saveResult({
        sessionId: receipt.sessionId,
        delegationId: receipt.delegationId,
        summary: summary.text,
        source: summary.source,
        completedAt: receipt.settledAt ?? receipt.updatedAt,
    });
    logDelegationResult(logger, receipt, { outcome: 'stored', source: summary.source });
}
