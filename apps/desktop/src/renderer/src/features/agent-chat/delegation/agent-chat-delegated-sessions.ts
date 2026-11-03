import type { AgentDelegationSession } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import type { DelegationCopy } from '../../delegation/delegation-copy';
import {
    delegationAttentionCounts,
    isDelegationFailed,
    isDelegationNeedsInput,
} from '../../delegation/delegation-feed';

/**
 * The counts the Delegated Sessions strip's header states: every child Session the Chat delegated to, and how many of
 * them need the user or failed.
 */
export interface DelegatedSessionsSummary {
    failed: number;
    needsInput: number;
    total: number;
}

export function delegatedSessionsSummary(
    entries: ReadonlyArray<Pick<AgentDelegationSession, 'failure' | 'status'>>,
): DelegatedSessionsSummary {
    return { ...delegationAttentionCounts(entries), total: entries.length };
}

/**
 * The header's parts, `3 delegated`, then `1 needs input` and `1 failed` only when there are some. A task waiting on a
 * question or permission is "needs input", never "approval", because it can be a question; an `answer_unavailable` task
 * is neither needs-input nor failed.
 */
export function delegatedSessionsHeaderParts(
    summary: DelegatedSessionsSummary,
    t: Translate,
): { count: string; failed?: string; needsInput?: string } {
    return {
        count: t('delegation.strip.count', { count: summary.total }),
        ...(summary.failed > 0 && {
            failed: t('delegation.strip.failed', { count: summary.failed }),
        }),
        ...(summary.needsInput > 0 && {
            needsInput: t(
                summary.needsInput === 1
                    ? 'delegation.strip.needsInputOne'
                    : 'delegation.strip.needsInputOther',
                { count: summary.needsInput },
            ),
        }),
    };
}

/**
 * The rows in the order a person should look at them: tasks that need input, then failures, then everything else, each
 * group keeping the Server's order (newest Session first). The sort is stable, so a row never jumps for a reason other
 * than its own state.
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
