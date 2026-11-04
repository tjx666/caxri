import type { CaxriDatabase, StoredAgentDelegation } from '../db';

/**
 * Whether a task runs in an `independent` Session: one an Agent started for its own task and does not wait on. Its
 * creator is told nothing, is rolled up nothing, and is asked nothing, so a question or a permission request of the
 * task goes straight to the user, as for a Session the user started.
 */
export function isIndependentTask(
    database: Pick<CaxriDatabase, 'getSession'>,
    task: Pick<StoredAgentDelegation, 'receipt'>,
): boolean {
    return database.getSession(task.receipt.sessionId)?.createdByRelation === 'independent';
}
