import type {
    AgentChatActivity,
    AgentChatPlan,
    AgentChatPlanProgress,
    AgentChatSnapshot,
    AgentChatTask,
} from '@caxri/protocol';
import { agentChatPlanProgress, agentChatTaskStrip } from '@caxri/protocol';

import type { Translate } from '../../../../i18n';
import { agentChatTaskTitle } from '../../tasks/agent-chat-tasks';

/**
 * Which detail the status row's popover shows: each badge opens only its own section.
 */
export type AgentChatStatusRowSection = 'plan' | 'tasks';

/**
 * What leads the status row on the left. While the Chat works or waits, the turn owns it; once the turn ended, what
 * still needs the user takes it in this order: one running task inline (so one click stops it), several running tasks
 * as a count, failures the user has not looked at, then a plan the turn left unfinished.
 */
type AgentChatStatusRowLead =
    | { kind: 'activity'; activity: AgentChatActivity }
    | { kind: 'task'; task: AgentChatTask }
    | { kind: 'tasks'; count: number }
    | { kind: 'failures'; count: number }
    | { kind: 'plan'; progress: AgentChatPlanProgress };

export interface AgentChatStatusRowView {
    lead: AgentChatStatusRowLead;
    /**
     * The plan badge's progress; absent when the badge is hidden.
     */
    planBadge: AgentChatPlanProgress | undefined;
    /**
     * The background task badge's counts; absent when the badge is hidden.
     */
    taskBadge: { running: number; unseenFailures: number } | undefined;
    /**
     * The plan the popover lists, with its progress.
     */
    plan: { plan: AgentChatPlan; progress: AgentChatPlanProgress } | undefined;
    /**
     * Running tasks in start order.
     */
    running: AgentChatTask[];
    /**
     * Failed tasks, most recent first; the popover lists them above the running ones.
     */
    failed: AgentChatTask[];
    /**
     * Completed and stopped tasks, most recent first, behind the popover's ended count.
     */
    ended: AgentChatTask[];
    /**
     * Failures that ended in the latest turn and that the user has not looked at: they put a dot on the task glyph and
     * keep the row up after the turn ends.
     */
    unseenFailureIds: string[];
}

/**
 * When the latest turn started. A failure older than that is history the conversation already reported, so reopening a
 * Chat never lights up every failure it ever had.
 */
export function agentChatLatestTurnStart(
    snapshot: Pick<AgentChatSnapshot, 'turns'> | undefined,
): number | undefined {
    return snapshot?.turns.at(-1)?.startedAt;
}

/**
 * The single status row above the composer, which replaces the docked plan card, the background work strip, and the
 * activity row: what leads it, which badges show, and what each badge's popover lists. `undefined` means no row. The
 * plan badge shows while the Chat is busy, and after the turn while an unfinished plan shares the row with tasks or
 * failures; a finished plan leaves with its turn. The task badge shows while the Chat is busy and anything runs or
 * failed unseen; after the turn the task lead says the same, so a second badge would repeat it. A turn waiting on the
 * user shows the row only for its badges.
 */
export function agentChatStatusRowView({
    activity,
    latestTurnStartedAt,
    plan,
    seenFailureIds,
    tasks,
}: {
    activity: AgentChatActivity | undefined;
    latestTurnStartedAt: number | undefined;
    plan: AgentChatPlan | undefined;
    seenFailureIds: ReadonlySet<string>;
    tasks: readonly AgentChatTask[] | undefined;
}): AgentChatStatusRowView | undefined {
    const { running, ended: allEnded } = agentChatTaskStrip(tasks);
    const failed = allEnded.filter((task) => task.status === 'failed');
    const ended = allEnded.filter((task) => task.status !== 'failed');
    const unseenFailureIds = failed
        .filter(
            (task) =>
                !seenFailureIds.has(task.id) &&
                (latestTurnStartedAt === undefined || (task.endedAt ?? 0) >= latestTurnStartedAt),
        )
        .map((task) => task.id);
    const progress = plan && plan.steps.length > 0 ? agentChatPlanProgress(plan) : undefined;
    const isPlanUnfinished = progress !== undefined && progress.completed < progress.total;
    const hasTaskNews = running.length > 0 || unseenFailureIds.length > 0;
    const lead = statusRowLead(activity, running, unseenFailureIds.length, progress);
    if (!lead) return undefined;
    const isBusy = activity !== undefined;
    const planBadge =
        progress && (isBusy || (isPlanUnfinished && hasTaskNews)) ? progress : undefined;
    const taskBadge =
        isBusy && hasTaskNews
            ? { running: running.length, unseenFailures: unseenFailureIds.length }
            : undefined;
    // A waiting turn has no lead of its own (its request card says so), so the row shows only for its badges.
    if (!planBadge && !taskBadge && activity?.kind === 'waiting') return undefined;
    return {
        lead,
        planBadge,
        taskBadge,
        plan: plan && progress ? { plan, progress } : undefined,
        running,
        failed,
        ended,
        unseenFailureIds,
    };
}

function statusRowLead(
    activity: AgentChatActivity | undefined,
    running: readonly AgentChatTask[],
    unseenFailures: number,
    progress: AgentChatPlanProgress | undefined,
): AgentChatStatusRowLead | undefined {
    if (activity) return { kind: 'activity', activity };
    if (running.length === 1) return { kind: 'task', task: running[0] };
    if (running.length > 1) return { kind: 'tasks', count: running.length };
    if (unseenFailures > 0) return { kind: 'failures', count: unseenFailures };
    if (progress && progress.completed < progress.total) return { kind: 'plan', progress };
    return undefined;
}

/**
 * How many background tasks failed, as the row and its live region say it.
 */
export function agentChatFailuresText(count: number, t: Translate): string {
    return count === 1
        ? t('agentChat.status.tasksFailedOne')
        : t('agentChat.status.tasksFailedOther', { count });
}

/**
 * The plan badge's accessible name: how far the plan got, and the step in progress when there is one.
 */
export function agentChatPlanBadgeLabel(
    plan: NonNullable<AgentChatStatusRowView['planBadge']>,
    t: Translate,
): string {
    const { completed, current, total } = plan;
    return current
        ? t('agentChat.plan.progressWithCurrent', { completed, current, total })
        : t('agentChat.plan.progress', { completed, total });
}

/**
 * The background work badge's accessible name: how many tasks run and, when some failed unseen, how many.
 */
export function agentChatTaskBadgeLabel(
    badge: NonNullable<AgentChatStatusRowView['taskBadge']>,
    t: Translate,
): string {
    const parts = [
        badge.running > 0 && t('agentChat.tasks.runningCount', { count: badge.running }),
        badge.unseenFailures > 0 && agentChatFailuresText(badge.unseenFailures, t),
    ];
    return t('agentChat.status.tasksBadge', { summary: parts.filter(Boolean).join(', ') });
}

/**
 * What the row's polite live region says: the turn's own text while the Chat is busy, otherwise what leads the row. A
 * failure the user has not seen joins either, so a background task failing mid-turn is announced rather than only drawn
 * as a dot. The ticking elapsed time and usage figures never are.
 */
export function agentChatStatusRowAnnouncement(
    view: AgentChatStatusRowView,
    activityText: string,
    t: Translate,
): string {
    const failures = view.unseenFailureIds.length;
    const { lead } = view;
    switch (lead.kind) {
        case 'activity': {
            return failures > 0
                ? `${activityText}. ${agentChatFailuresText(failures, t)}`
                : activityText;
        }
        case 'failures': {
            return agentChatFailuresText(failures, t);
        }
        case 'plan': {
            return t('agentChat.status.planStopped', {
                completed: lead.progress.completed,
                total: lead.progress.total,
            });
        }
        case 'task':
        case 'tasks': {
            const running =
                lead.kind === 'task'
                    ? t('agentChat.status.taskRunning', { title: agentChatTaskTitle(lead.task, t) })
                    : t('agentChat.status.tasksRunning', { count: lead.count });
            return failures > 0 ? `${running}. ${agentChatFailuresText(failures, t)}` : running;
        }
    }
}
