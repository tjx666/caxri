import type { CaxriBotRowReader, CaxriDatabase, StoredAgentDelegation } from '../../db';
import { caxriBotTerminal } from '../../db';

/**
 * Why a task's caller is never sent a notice.
 */
export type IneligibleReason = 'external' | 'bot' | 'handoff';

/**
 * The managed Agent launch that delegated a task, which is the only recipient of its notices.
 */
export interface NoticeCaller {
    terminalId: string;
    launchId: string;
}

/**
 * Who a task's notices go to, or why nobody. Only a managed Agent (a Chat or a PTY, with a known Terminal and launch)
 * is notified: an external delegation client, the owner's CLI, and Desktop have no Terminal to write to and read the
 * task through queries. Caxri Bot keeps its own notifier, and a `handoff` Session is one its creator gave up, so its
 * creator does not wait for it.
 */
export function noticeCallerOf(
    database: Pick<CaxriDatabase, 'getSession'> & CaxriBotRowReader,
    record: StoredAgentDelegation,
): NoticeCaller | { reason: IneligibleReason } {
    const terminalId = record.receipt.callerTerminalId;
    const launchId = record.callerLaunchId;
    if (!terminalId || !launchId || record.principal.kind !== 'agent')
        return { reason: 'external' };
    // The constant-time reader: this runs for every task that becomes active.
    if (caxriBotTerminal(database)?.terminalId === terminalId) return { reason: 'bot' };
    if (database.getSession(record.receipt.sessionId)?.createdByRelation === 'handoff')
        return { reason: 'handoff' };
    return { terminalId, launchId };
}
