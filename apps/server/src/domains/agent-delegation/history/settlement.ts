import { isDelegationActive } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase, StoredAgentDelegation } from '../../db';
import { isNewlyCompleted, recordDelegationResult } from '../feed';
import { historyRow, MAX_SEARCHABLE_DELEGATION_HISTORY } from './row';

type Saved = Pick<StoredAgentDelegation, 'answer' | 'receipt'>;

/**
 * Why a history write failed, as a closed set a log carries instead of the error message (which can echo SQL values).
 */
type HistoryFailureReason = 'constraint' | 'database' | 'unknown';

function failureReason(error: unknown): HistoryFailureReason {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return 'constraint';
    if (typeof code === 'string' && code.startsWith('SQLITE')) return 'database';
    return 'unknown';
}

/**
 * Whether a save of a settled task must write its history row: it just settled, its outcome or failure changed, or it
 * has no row yet. The last arm is the retry: a write that failed (or a task that settled before history existed) is
 * attempted again by the task's next save, so a failure is never skipped forever. A later bookkeeping save of a
 * recorded task writes nothing.
 */
export function shouldRecordHistory(
    saved: Saved,
    before: Saved | undefined,
    hasRow: boolean,
): boolean {
    if (isDelegationActive(saved.receipt)) return false;
    return (
        !hasRow ||
        before === undefined ||
        isDelegationActive(before.receipt) ||
        before.receipt.status !== saved.receipt.status ||
        before.receipt.failure !== saved.receipt.failure
    );
}

/**
 * The writes a save of a task owes its Session once the task settles: the Delegated Sessions feed result and the
 * history row. Each is isolated, because `save` has already stored the receipt and still has to announce it; a throw
 * here would leave the receipt stored but never observed. A failed history write is logged with a closed reason and
 * retried by the next save (see {@link shouldRecordHistory}).
 */
export function recordSettlement(
    database: CaxriDatabase,
    saved: StoredAgentDelegation,
    before: StoredAgentDelegation | undefined,
    logger?: StructuredLogger,
    now: () => number = Date.now,
): void {
    if (isNewlyCompleted(saved, before)) {
        try {
            recordDelegationResult(database, saved, logger);
        } catch {
            // The feed result is a convenience read; the receipt, the history row, and the announcement still proceed.
        }
    }
    const { history } = database.agentDelegations;
    const { receipt } = saved;
    if (isDelegationActive(receipt)) return;
    let hasRow: boolean;
    try {
        hasRow = history.has(receipt.delegationId);
    } catch {
        hasRow = false;
    }
    if (!shouldRecordHistory(saved, before, hasRow)) return;
    const startedAt = now();
    const fields = {
        delegationId: receipt.delegationId,
        outcome: receipt.status,
        failure: receipt.failure ?? null,
    };
    try {
        const { isInsert, compactedCount } = history.record(
            historyRow(saved, database.getSession(receipt.sessionId)?.title),
            MAX_SEARCHABLE_DELEGATION_HISTORY,
            startedAt,
        );
        logger?.write('info', logEventCatalog.agentDelegation.historyRecorded, {
            fields: {
                ...fields,
                isInsert,
                compactedCount,
                durationMs: now() - startedAt,
                result: 'ok',
            },
        });
    } catch (error) {
        logger?.write('warn', logEventCatalog.agentDelegation.historyRecorded, {
            fields: {
                ...fields,
                durationMs: now() - startedAt,
                result: 'failed',
                reason: failureReason(error),
            },
        });
    }
}
