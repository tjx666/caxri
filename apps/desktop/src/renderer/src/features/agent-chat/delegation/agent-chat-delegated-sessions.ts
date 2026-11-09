import type { AgentDelegationAttentionReply, AgentDelegationSession } from '@caxri/protocol';
import { isDelegationFailed, isDelegationNeedsInput } from '@caxri/protocol';
import { omit } from 'es-toolkit';

import type { Translate } from '../../../i18n';
import type { DelegationCopy } from '../../delegation/delegation-copy';
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
 * failures, then everything else (a task still asking the Agent that delegated it ranks with the waiting ones, because
 * the user has nothing to do yet), each group keeping the Server's order (newest Session first). The sort is stable, so
 * a row never jumps for a reason other than its own state.
 */
export function sortDelegatedSessions(
    entries: readonly AgentDelegationSession[],
): AgentDelegationSession[] {
    const rank = (entry: AgentDelegationSession): number =>
        isDelegationNeedsInput(entry) ? 0 : isDelegationFailed(entry) ? 1 : 2;
    return entries.toSorted((left, right) => rank(left) - rank(right));
}

/**
 * What a strip row says under the title.
 *
 * - `step`: the live step of an active task.
 * - `summary`: a completed task's result summary, with `isExcerpt` when it is the first paragraph rather than the Agent's
 *   own `Summary:` line.
 * - `status`: the status copy, for everything else (a failure, a task waiting on the user, a completed task whose result
 *   is missing or belongs to an earlier task).
 */
export type DelegatedSessionLine =
    | { kind: 'step'; text: string }
    | { isExcerpt: boolean; kind: 'summary'; text: string }
    | { detail?: string; kind: 'status'; text: string };

export function delegatedSessionLine(
    entry: Pick<AgentDelegationSession, 'delegationId' | 'result' | 'status' | 'step'>,
    copy: Pick<DelegationCopy, 'detail' | 'glyph' | 'headline'>,
): DelegatedSessionLine {
    if (copy.glyph === 'running' && entry.step) return { kind: 'step', text: entry.step };
    // A stored result belongs to the newest task only when the IDs match; after a follow-up started or failed, the
    // summary on the entry is an earlier task's and must not read as this one's outcome.
    if (
        entry.status === 'completed' &&
        entry.result &&
        entry.delegationId !== undefined &&
        entry.result.delegationId === entry.delegationId
    )
        return {
            isExcerpt: entry.result.source === 'excerpt',
            kind: 'summary',
            text: entry.result.summary,
        };
    return {
        kind: 'status',
        text: copy.headline,
        ...(copy.detail && { detail: copy.detail }),
    };
}

/**
 * The `<n> PR files` label, or `undefined` when GitHub reported no positive count. The count is the whole pull
 * request's, not this delegation's output, which the label says. Never `0`: unknown is omitted.
 */
export function delegationPrFilesLabel(
    changedFiles: number | undefined,
    t: Translate,
): string | undefined {
    if (changedFiles === undefined || !Number.isSafeInteger(changedFiles) || changedFiles <= 0)
        return undefined;
    return t(changedFiles === 1 ? 'delegation.strip.prFilesOne' : 'delegation.strip.prFilesOther', {
        count: changedFiles,
    });
}

/**
 * The pull request a finished task's row links to, or `undefined` when it has none of its own. A task that worked on
 * the delegating Session's branch reports that Session's pull request; repeating it on every row says nothing the user
 * does not already know from the Chat they are in, so the row shows a pull request only when it differs.
 */
export function delegatedOwnPullRequest<PullRequest extends { url: string }>(
    child: PullRequest | undefined,
    parent: PullRequest | undefined,
): PullRequest | undefined {
    if (!child || child.url === parent?.url) return undefined;
    return child;
}
