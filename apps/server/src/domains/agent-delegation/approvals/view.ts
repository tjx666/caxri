import type {
    DelegationApproval,
    DelegationApprovalSummary,
    DelegationWaitingOn,
} from '@caxri/protocol';
import { MAX_APPROVAL_PATHS_IN_REPLY } from '@caxri/protocol';

import type { CaxriDatabase } from '../../db';
import type { DelegationApprovalEnvironment, PendingApproval } from './entry';
import { isHeldKind } from './facts';
import { revisionOf } from './fingerprint';

type Entries = ReadonlyMap<string, readonly PendingApproval[]>;

/**
 * The entry the delegating Agent should see: the oldest request it may still decide, else the oldest remaining. An
 * entry whose path check has not answered yet is not offered.
 */
function selected(entries: Entries, delegationId: string): PendingApproval | undefined {
    const list = entries.get(delegationId);
    const decidable = list?.find(
        (entry) =>
            entry.coverage.covered &&
            entry.escalatedAt === undefined &&
            entry.path.state !== 'pending',
    );
    return decidable ?? list?.find((entry) => entry.path.state !== 'pending');
}

function summaryOf(entry: PendingApproval): DelegationApprovalSummary {
    return {
        requestId: entry.requestId,
        kind: entry.kind,
        covered: entry.coverage.covered,
        coverageReason: entry.coverage.covered ? 'covered' : entry.coverage.reason,
        escalated: entry.escalatedAt !== undefined,
        requestedAt: entry.requestedAt,
    };
}

/**
 * The pending approval of a task as its delegating Agent reads it in `wait` and `status`, request content included: the
 * one place the content leaves the Chat. Only while the task is blocked.
 */
export function approvalView(
    entries: Entries,
    source: {
        database: Pick<CaxriDatabase, 'agentDelegations'>;
        approvals?: DelegationApprovalEnvironment;
    },
    delegationId: string,
): DelegationApproval | undefined {
    const entry = selected(entries, delegationId);
    const request = source.approvals
        ?.chat(entry?.childTerminalId ?? '')
        ?.requests.find((candidate) => candidate.id === entry?.requestId);
    const task = entry && source.database.agentDelegations.get(delegationId);
    if (!entry || !isHeldKind(request) || task?.receipt.status !== 'blocked') return undefined;
    return {
        ...summaryOf(entry),
        revision: revisionOf(entry.fingerprint),
        ...(request.kind === 'command' && {
            ...(request.command && { command: request.command }),
            ...(request.cwd && { cwd: request.cwd }),
        }),
        ...(request.kind === 'fileChange' &&
            request.paths && { paths: request.paths.slice(0, MAX_APPROVAL_PATHS_IN_REPLY) }),
    };
}

/**
 * Whom a task with pending requests waits on, from every request its Chat lists: the user while any request is not a
 * covered, unescalated entry (an uncovered or escalated approval, a question, a tool request, or one with no entry),
 * else the delegating Agent.
 */
function blocking(
    entries: Entries,
    environment: DelegationApprovalEnvironment | undefined,
    entry: PendingApproval,
): DelegationWaitingOn {
    const requests = environment?.chat(entry.childTerminalId)?.requests ?? [];
    const tracked = entries.get(entry.delegationId) ?? [];
    return requests.every((request) => {
        const match = tracked.find((candidate) => candidate.requestId === request.id);
        return match?.coverage.covered && match.escalatedAt === undefined;
    })
        ? 'parent'
        : 'user';
}

/**
 * What the Delegated Sessions feed shows of each named task's approvals: the state of the selected request, never its
 * content, and whom the task waits on.
 */
export function approvalFeed(
    entries: Entries,
    environment: DelegationApprovalEnvironment | undefined,
    delegationIds: readonly string[],
): Map<string, { approval: DelegationApprovalSummary; waitingOn: DelegationWaitingOn }> {
    const found = new Map<
        string,
        { approval: DelegationApprovalSummary; waitingOn: DelegationWaitingOn }
    >();
    for (const delegationId of delegationIds) {
        const entry = selected(entries, delegationId);
        if (entry)
            found.set(delegationId, {
                approval: summaryOf(entry),
                waitingOn: blocking(entries, environment, entry),
            });
    }
    return found;
}
