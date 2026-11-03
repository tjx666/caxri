import type {
    AgentChatItemStatus,
    AgentChatWorkflow,
    AgentChatWorkflowCounts,
    AgentChatWorkflowMember,
    AgentUsageReadout,
} from '@caxri/protocol';
import {
    agentChatWorkflowAgentKind,
    agentChatWorkflowCounts,
    agentChatWorkflowCurrentPhase,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import type { Translate } from '../../../../i18n';

/**
 * A workflow member the user has heard nothing from for this long reads as possibly stuck.
 */
export const WORKFLOW_MEMBER_QUIET_MS = 2 * 60_000;

/**
 * What a workflow's progress label shows: the running phase with its own count (`Review 2/5`) while the run works, the
 * whole run's count (`10/11`) otherwise, plus how many members failed or were interrupted, which never hide behind a
 * finished count.
 */
export interface AgentChatWorkflowProgressLabel {
    /**
     * The phase title, or undefined for the whole run's count.
     */
    phase: string | undefined;
    done: number;
    total: number;
    failed: number;
    stopped: number;
}

export function agentChatWorkflowProgressLabel(
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>,
    isRunning: boolean,
): AgentChatWorkflowProgressLabel | undefined {
    const counts = agentChatWorkflowCounts(workflow.members);
    if (counts.total === 0) return undefined;
    const phase = isRunning ? agentChatWorkflowCurrentPhase(workflow) : undefined;
    const scope = phase && workflow.phases.length > 1 ? phase.counts : counts;
    return {
        phase: phase && workflow.phases.length > 1 ? phase.title : undefined,
        done: scope.completed + scope.failed + scope.stopped,
        total: scope.total,
        failed: counts.failed,
        stopped: counts.stopped,
    };
}

/**
 * Whether a member went quiet: running, and its last reported step is older than {@link WORKFLOW_MEMBER_QUIET_MS}.
 */
export function isAgentChatWorkflowMemberQuiet(
    member: Pick<AgentChatWorkflowMember, 'lastProgressAt' | 'startedAt' | 'status'>,
    now: number,
): boolean {
    const last = member.lastProgressAt ?? member.startedAt;
    return (
        member.status === 'running' && last !== undefined && now - last >= WORKFLOW_MEMBER_QUIET_MS
    );
}

/**
 * The run's spend as the sum of what each member's transcript billed, priced like the status bar. A member with an
 * unpriced model makes the total a lower bound (`≥$1.20`); no readout at all leaves it unknown.
 */
export function agentChatWorkflowBilled(
    readouts: Iterable<AgentUsageReadout | null | undefined>,
): { totalTokens: number; cost: string | undefined } | undefined {
    let totalTokens = 0;
    let costUsd = 0;
    let isPartial = false;
    let hasPriced = false;
    let hasAny = false;
    for (const readout of readouts) {
        if (!readout) continue;
        hasAny = true;
        totalTokens += readout.tokens.total;
        costUsd += readout.costUsd;
        if (readout.unpricedModels.length > 0) isPartial = true;
        if (readout.unpricedModels.length < readout.models.length) hasPriced = true;
    }
    if (!hasAny) return undefined;
    const cost = hasPriced ? `${isPartial ? '≥' : ''}${formatUsd(costUsd)}` : undefined;
    return { totalTokens, cost };
}

/**
 * The draft "Ask the Agent to continue" puts in the composer for an interrupted run. It is addressed to the Agent, so
 * it stays in English like a prompt; the user reviews and sends it. Resuming an interrupted run follows Mux and Synara,
 * but Caxri never sends on the user's behalf.
 */
export function agentChatWorkflowResumeDraft(name: string, runId: string | undefined): string {
    const run = runId ? ` (run ${runId})` : '';
    return `The workflow "${name}"${run} was interrupted before it finished. Resume it from where it stopped, reusing the results of members that already completed.`;
}

/**
 * Who ran a member, for its tooltip: `Subagent`, `Claude Code built-in · Explore`, or `Custom agent · code-reviewer`.
 */
export function agentChatWorkflowMemberType(
    member: Pick<AgentChatWorkflowMember, 'agentType'>,
    t: Translate,
): string {
    const kind = agentChatWorkflowAgentKind(member.agentType);
    if (kind === 'ordinary') return t('agentChat.workflow.kind.ordinary');
    return t(
        kind === 'custom' ? 'agentChat.workflow.kind.custom' : 'agentChat.workflow.kind.builtIn',
        {
            type: member.agentType ?? '',
        },
    );
}

/**
 * A member row's second line, one thing at a time: the error of a failed member, the queue notice, the step a running
 * member is on (`Bash git status`), the result of a finished one, or that it was interrupted. Orca, Jean, and the Codex
 * app keep member rows to a status and a number or two with the current action below, as this line does.
 */
export function agentChatWorkflowMemberDetail(
    member: Pick<
        AgentChatWorkflowMember,
        'error' | 'lastToolName' | 'lastToolSummary' | 'resultPreview' | 'status'
    >,
    t: Translate,
): string | undefined {
    switch (member.status) {
        case 'failed': {
            return member.error;
        }
        case 'queued': {
            return t('agentChat.workflow.queued');
        }
        case 'running': {
            return member.lastToolName
                ? [member.lastToolName, member.lastToolSummary].filter(Boolean).join(' ')
                : undefined;
        }
        case 'completed': {
            return member.resultPreview;
        }
        case 'stopped': {
            return member.resultPreview ?? t('agentChat.workflow.memberStopped');
        }
    }
}

/**
 * The workflow tab header's line, most important first so a narrow header drops the tail: subagents done of total,
 * failed, interrupted, cost, then tokens. `compact` drops the tokens, which the header's tooltip still carries.
 */
export function agentChatWorkflowHeaderStats(
    workflow: Pick<AgentChatWorkflow, 'members'>,
    billed: { totalTokens: number; cost: string | undefined } | undefined,
    t: Translate,
    { compact }: { compact: boolean },
): string {
    const counts = agentChatWorkflowCounts(workflow.members);
    const parts = [
        t('agentChat.workflow.subagentsDone', {
            done: counts.completed + counts.failed + counts.stopped,
            total: counts.total,
        }),
        counts.failed > 0 ? t('agentChat.workflow.failed', { count: counts.failed }) : undefined,
        counts.stopped > 0 ? t('agentChat.workflow.stopped', { count: counts.stopped }) : undefined,
        billed?.cost,
        !compact && billed?.totalTokens
            ? t('agentChat.tasks.usageTokens', { tokens: formatTokens(billed.totalTokens) })
            : undefined,
    ];
    return parts.filter(Boolean).join(' · ');
}

/**
 * Where a phase stands, which decides how its group opens: a running or failed phase is expanded, a phase that ended
 * normally collapses to one row, and one with no started member only says it has not started. Expanding failed phases
 * and pinning the result follow Mux (AGPL, idea only).
 */
export type AgentChatWorkflowPhaseState = 'notStarted' | 'running' | 'failed' | 'ended';

export function agentChatWorkflowPhaseState(
    counts: AgentChatWorkflowCounts,
): AgentChatWorkflowPhaseState {
    if (counts.running > 0) return 'running';
    if (counts.failed > 0) return 'failed';
    if (counts.total === counts.queued) return counts.total === 0 ? 'notStarted' : 'running';
    return counts.queued > 0 ? 'running' : 'ended';
}

/**
 * How long a phase took, from its first member's start to its last member's end; undefined until a member reported
 * both.
 */
export function agentChatWorkflowPhaseDurationMs(
    members: ReadonlyArray<Pick<AgentChatWorkflowMember, 'startedAt' | 'usage'>>,
): number | undefined {
    let start = Infinity;
    let end = -Infinity;
    for (const member of members) {
        if (member.startedAt === undefined) continue;
        start = Math.min(start, member.startedAt);
        if (member.usage?.durationMs !== undefined)
            end = Math.max(end, member.startedAt + member.usage.durationMs);
    }
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

/**
 * A member's status as the shared status glyph draws it: interrupted for a stopped member. A queued member has not
 * started, which the glyph cannot say, so rows show the word `Waiting` instead and only a member's own header falls
 * back to the running spinner.
 */
export function agentChatWorkflowMemberGlyphStatus(
    status: AgentChatWorkflowMember['status'],
): AgentChatItemStatus {
    if (status === 'stopped') return 'interrupted';
    return status === 'queued' ? 'running' : status;
}
