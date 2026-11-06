import type { AgentDelegationReceipt } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { CaxriDatabase, DelegationNoticeKind } from '../../db';
import { noticeCallerOf } from './eligibility';
import { NOTICE_KINDS } from './kinds';

type NoticeDatabase = Pick<CaxriDatabase, 'agentDelegations' | 'getSession'> &
    Parameters<typeof noticeCallerOf>[0];

/**
 * Marks the notices of one task and kind that are owed to `terminalId` as read.
 */
function acknowledge(
    database: NoticeDatabase,
    now: number,
    delegationId: string,
    kind: DelegationNoticeKind,
    terminalId: string,
): void {
    const store = database.agentDelegations.notices;
    const stored = store.forDelegation(delegationId, kind);
    for (const notice of stored)
        if (notice.callerTerminalId === terminalId) store.acknowledge(notice.id, now);
    if (!NOTICE_KINDS[kind].recordsReadBeforeRegistered || stored.length > 0) return;
    // Read before it was registered (a retry plan held it back): record that it was read so a cancelled plan does not
    // announce it again.
    const record = database.agentDelegations.get(delegationId);
    const caller = record && noticeCallerOf(database, record);
    if (!caller || !('terminalId' in caller) || caller.terminalId !== terminalId) return;
    const id = `${kind}:${delegationId}`;
    store.register({
        id,
        delegationId,
        kind,
        callerTerminalId: caller.terminalId,
        callerLaunchId: caller.launchId,
        now,
    });
    store.claim([id], 'skipped', now);
    store.acknowledge(id, now);
}

/**
 * The caller read what a notice would report: a settled receipt, an open question, or a pending approval.
 */
export function acknowledgeRead(
    database: NoticeDatabase,
    now: number,
    read: { receipt: AgentDelegationReceipt; outcome?: string },
    callerTerminalId: string,
): void {
    const { delegationId } = read.receipt;
    if (!isDelegationActive(read.receipt))
        acknowledge(database, now, delegationId, 'settled', callerTerminalId);
    else if (read.outcome === 'question')
        acknowledge(database, now, delegationId, 'question', callerTerminalId);
    else if (read.outcome === 'approval')
        acknowledge(database, now, delegationId, 'approval', callerTerminalId);
}
