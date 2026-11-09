import type { AgentChatTask, AgentChatWorkflow, AgentChatWorkflowMember } from '@caxri/protocol';
import {
    agentChatWorkflowCounts,
    agentChatWorkflowPhaseGroups,
    agentChatWorkflowProgressLabel,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * How a workflow run (Claude Code's `Workflow` tool) reads on the phone: the progress beside its row, the run's own
 * counts, and its members grouped by phase, each opening that subagent's messages. The phone's copy of a run is the
 * outline `clipAgentChatWorkflowForMobile` keeps, so previews, timings, and usage are Desktop's alone.
 */

/**
 * A run's progress where it is listed, as Desktop's strip shows it: `Review 2/5` while a phase runs, `10/11` for the
 * whole run otherwise, then failed and interrupted members, which never hide behind a finished count. Undefined before
 * the first member starts.
 */
export function agentChatWorkflowProgressText(
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>,
    isRunning: boolean,
    t: Translate = translate,
): string | undefined {
    const label = agentChatWorkflowProgressLabel(workflow, isRunning);
    if (!label) return undefined;
    const count = t('chat.tasks.workflow.progress', { done: label.done, total: label.total });
    return [
        label.phase ? `${label.phase} ${count}` : count,
        label.failed > 0 ? t('chat.tasks.workflow.failed', { count: label.failed }) : undefined,
        label.stopped > 0 ? t('chat.tasks.workflow.stopped', { count: label.stopped }) : undefined,
    ]
        .filter(Boolean)
        .join(' · ');
}

/**
 * The run's own line at the top of its detail: subagents done of total, then failures and interruptions.
 */
export function agentChatWorkflowSummary(
    workflow: Pick<AgentChatWorkflow, 'members'>,
    t: Translate = translate,
): string {
    const counts = agentChatWorkflowCounts(workflow.members);
    return [
        t('chat.tasks.workflow.subagentsDone', {
            done: counts.completed + counts.failed + counts.stopped,
            total: counts.total,
        }),
        counts.failed > 0 ? t('chat.tasks.workflow.failed', { count: counts.failed }) : undefined,
        counts.stopped > 0
            ? t('chat.tasks.workflow.stopped', { count: counts.stopped })
            : undefined,
    ]
        .filter(Boolean)
        .join(' · ');
}

const MEMBER_STATUS_LABELS = {
    queued: 'chat.tasks.workflow.waiting',
    running: 'chat.tasks.status.running',
    completed: 'chat.tasks.status.completed',
    failed: 'chat.tasks.status.failed',
    stopped: 'chat.tasks.status.stopped',
} as const;

/**
 * One member as its row shows it. A member the compact outline sent without a label reads `Subagent 12`; one without a
 * `taskId` (not yet named by the provider, or sent compact) cannot be opened.
 */
export interface AgentChatWorkflowMemberRow {
    key: string;
    title: string;
    /**
     * The task status its glyph draws; a queued member shows the word `Waiting` instead of a spinner.
     */
    glyphStatus: AgentChatTask['status'] | undefined;
    statusLabel: string;
    taskId: string | undefined;
    accessibilityLabel: string;
}

export function agentChatWorkflowMemberRow(
    member: AgentChatWorkflowMember,
    t: Translate = translate,
): AgentChatWorkflowMemberRow {
    const title = member.label || t('chat.tasks.workflow.member', { index: member.index + 1 });
    const statusLabel = t(MEMBER_STATUS_LABELS[member.status]);
    return {
        key: String(member.index),
        title,
        glyphStatus: member.status === 'queued' ? undefined : member.status,
        statusLabel,
        taskId: member.taskId,
        accessibilityLabel: t('chat.tasks.workflow.memberLabel', { title, status: statusLabel }),
    };
}

/**
 * The members of one phase under its title and count. `title` is undefined only when the script declared no phases, so
 * the list needs no heading.
 */
export interface AgentChatWorkflowSection {
    key: string;
    title: string | undefined;
    progress: string;
    members: AgentChatWorkflowMemberRow[];
}

/**
 * The run's members by phase in the order the script declared them, skipping a phase with no member yet; members
 * without a phase come last under `Other`, or with no heading when no phase was declared.
 */
export function agentChatWorkflowSections(
    workflow: Pick<AgentChatWorkflow, 'members' | 'phases'>,
    t: Translate = translate,
): AgentChatWorkflowSection[] {
    const groups = agentChatWorkflowPhaseGroups(workflow).filter(
        (group) => group.members.length > 0,
    );
    const isUnphased = groups.length === 1 && groups[0]?.title === undefined;
    return groups.map((group, index) => ({
        key: group.title ?? `unphased-${index}`,
        title: isUnphased ? undefined : (group.title ?? t('chat.tasks.workflow.otherPhase')),
        progress: t('chat.tasks.workflow.progress', {
            done: group.counts.completed + group.counts.failed + group.counts.stopped,
            total: group.counts.total,
        }),
        members: group.members.map((member) => agentChatWorkflowMemberRow(member, t)),
    }));
}

/**
 * The task a member's own detail reads (`mobile.agentChat.readTask` under its `workflow:<run>:<agent>` id) and polls
 * while it works. A queued member counts as running so its messages appear as soon as it starts.
 */
export function agentChatWorkflowMemberTask(
    member: Pick<AgentChatWorkflowMember, 'status'>,
    taskId: string,
): Pick<AgentChatTask, 'id' | 'kind' | 'status'> {
    return {
        id: taskId,
        kind: 'agent',
        status: member.status === 'queued' ? 'running' : member.status,
    };
}
