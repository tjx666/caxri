import type { AgentDelegationAttentionReply, AgentDelegationSession } from '@caxri/protocol';
import { isDelegationFailed, isDelegationNeedsInput } from '@caxri/protocol';
import { omit } from 'es-toolkit';

import type { Translate } from '../../../i18n';
import { delegationAttentionCounts } from '../../delegation/delegation-feed';

/**
 * The counts the Delegated Sessions strip's header states: every child Session the Chat delegated to, and how many of
 * them need the user, failed, or wait for a scheduled retry.
 */
export interface DelegatedSessionsSummary {
    /**
     * How many of the `needsInput` tasks wait on a permission request of a Chat.
     */
    approvals: number;
    /**
     * Tasks asking the Agent that delegated them, still inside the grace period. Not attention.
     */
    asking: number;
    failed: number;
    needsInput: number;
    total: number;
    waiting: number;
}

export function delegatedSessionsSummary(
    entries: ReadonlyArray<
        Pick<AgentDelegationSession, 'failure' | 'status'> &
            Partial<
                Pick<
                    AgentDelegationSession,
                    'approval' | 'retriedAs' | 'retryScheduledFor' | 'waitingOn'
                >
            >
    >,
    total: number = entries.length,
): DelegatedSessionsSummary {
    return { ...delegationAttentionCounts(entries), total };
}

/**
 * The strip's rows once the tree-wide roll-up joins the direct children: `entries` is every row in the order a person
 * should look at them, `viaBySessionId` names the direct child a deeper row sits under (for its "via" line), and
 * `isPartial` says the Server could not read or list every deeper item.
 */
export interface DelegatedSessionRows {
    entries: AgentDelegationSession[];
    isPartial: boolean;
    viaBySessionId: ReadonlyMap<string, string>;
}

/**
 * Joins the direct children (already collapsed by retry chain) with the deeper items the Server rolled up
 * (`agent.delegation.attention`), which it already folded by retry chain, filtered to what needs the user and capped. A
 * Session the direct read also lists keeps its direct row. Sorting is the strip's usual order, so a deeper item that
 * needs the user ranks with the direct ones, and a deeper row never appears for any other reason.
 */
export function mergeDeeperAttention(
    direct: readonly AgentDelegationSession[],
    reply: AgentDelegationAttentionReply | undefined,
): DelegatedSessionRows {
    const directIds = new Set(direct.map((entry) => entry.sessionId));
    const deeper = (reply?.items ?? []).filter((item) => !directIds.has(item.sessionId));
    return {
        entries: sortDelegatedSessions([
            ...deeper.map((item) => omit(item, ['branchSessionId'])),
            ...direct,
        ]),
        isPartial: reply?.isPartial ?? false,
        viaBySessionId: new Map(deeper.map((item) => [item.sessionId, item.branchSessionId])),
    };
}

/**
 * The header's parts, `3 delegated`, then `1 needs input`, `1 failed`, `1 retry waiting`, and `1 asking` only when
 * there are some. `asking` is muted text and is no attention: the caller leaves it out of the live-region announcement.
 * A task waiting on a question or permission is "needs input" because it can be a question; the part says "waiting for
 * your approval" only when every one of those tasks carries a permission request of a Chat (`approvals`). An
 * `answer_unavailable` task is neither needs-input nor failed.
 */
export function delegatedSessionsHeaderParts(
    summary: DelegatedSessionsSummary,
    t: Translate,
): { asking?: string; count: string; failed?: string; needsInput?: string; waiting?: string } {
    return {
        count: t('delegation.strip.count', { count: summary.total }),
        ...(summary.asking > 0 && {
            asking: t(
                summary.asking === 1
                    ? 'delegation.strip.askingOne'
                    : 'delegation.strip.askingOther',
                { count: summary.asking },
            ),
        }),
        ...(summary.failed > 0 && {
            failed: t('delegation.strip.failed', { count: summary.failed }),
        }),
        ...(summary.waiting > 0 && {
            waiting: t(
                summary.waiting === 1
                    ? 'delegation.strip.retryWaitingOne'
                    : 'delegation.strip.retryWaitingOther',
                { count: summary.waiting },
            ),
        }),
        ...(summary.needsInput > 0 && {
            needsInput: t(needsInputKey(summary), { count: summary.needsInput }),
        }),
    };
}

function needsInputKey(
    summary: Pick<DelegatedSessionsSummary, 'approvals' | 'needsInput'>,
): Parameters<Translate>[0] {
    const isOne = summary.needsInput === 1;
    if (summary.approvals === summary.needsInput)
        return isOne ? 'delegation.strip.approvalOne' : 'delegation.strip.approvalOther';
    return isOne ? 'delegation.strip.needsInputOne' : 'delegation.strip.needsInputOther';
}

/**
 * The rows in the order a person should look at them: tasks that need input (an escalated question included), then
 * failures, then everything still open or stopped (a task still asking the Agent that delegated it ranks with the
 * waiting ones, because the user has nothing to do yet), then completed tasks, each group keeping the Server's order
 * (newest Session first). The sort is stable, so a row never jumps for a reason other than its own state.
 */
export function sortDelegatedSessions(
    entries: readonly AgentDelegationSession[],
): AgentDelegationSession[] {
    const rank = (entry: AgentDelegationSession): number =>
        isDelegationNeedsInput(entry)
            ? 0
            : isDelegationFailed(entry)
              ? 1
              : entry.status === 'completed'
                ? 3
                : 2;
    return entries.toSorted((left, right) => rank(left) - rank(right));
}
