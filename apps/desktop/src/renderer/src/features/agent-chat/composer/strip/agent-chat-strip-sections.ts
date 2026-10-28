import type {
    AgentChatActivity,
    AgentChatPlan,
    AgentChatPlanProgress,
    AgentChatSnapshot,
    AgentChatTask,
} from '@caxri/protocol';
import { agentChatPlanProgress, agentChatTaskStrip } from '@caxri/protocol';

import type { Translate } from '../../../../i18n';

/**
 * The composer strip's Background work section.
 */
export interface AgentChatBackgroundWork {
    /**
     * Running tasks in start order.
     */
    running: AgentChatTask[];
    /**
     * Failures from the latest turn the user has not dismissed, most recent first: listed above the running tasks so a
     * failure is never buried.
     */
    failed: AgentChatTask[];
    /**
     * Every other ended task (completed, stopped, and failures already dismissed or older than the latest turn), most
     * recent first, behind the `Ended N` disclosure at the foot of the list.
     */
    ended: AgentChatTask[];
}

/**
 * The composer strip's Plan section.
 */
export interface AgentChatPlanSection {
    plan: AgentChatPlan;
    progress: AgentChatPlanProgress;
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
 * The Background work section above the composer, or `undefined` for none. It shows while anything runs or a failure
 * from the latest turn waits for the user, so a task that failed after the turn ended is not lost; once the last task
 * ends and every failure was dismissed it leaves, since the Agent reports results in the conversation and each task's
 * timeline row still opens it.
 */
export function agentChatBackgroundWork({
    latestTurnStartedAt,
    seenFailureIds,
    tasks,
}: {
    latestTurnStartedAt: number | undefined;
    seenFailureIds: ReadonlySet<string>;
    tasks: readonly AgentChatTask[] | undefined;
}): AgentChatBackgroundWork | undefined {
    const { running, ended: allEnded } = agentChatTaskStrip(tasks);
    const isUnseenFailure = (task: AgentChatTask): boolean =>
        task.status === 'failed' &&
        !seenFailureIds.has(task.id) &&
        (latestTurnStartedAt === undefined || (task.endedAt ?? 0) >= latestTurnStartedAt);
    const failed = allEnded.filter((task) => isUnseenFailure(task));
    if (running.length === 0 && failed.length === 0) return undefined;
    return {
        running,
        failed,
        ended: allEnded.filter((task) => !isUnseenFailure(task)),
    };
}

/**
 * The Plan section above the composer, or `undefined` for none: the latest plan while the Chat is busy, and after the
 * turn only while it is unfinished, so a finished plan leaves with its turn.
 */
export function agentChatPlanSection({
    activity,
    plan,
}: {
    activity: AgentChatActivity | undefined;
    plan: AgentChatPlan | undefined;
}): AgentChatPlanSection | undefined {
    if (!plan || plan.steps.length === 0) return undefined;
    const progress = agentChatPlanProgress(plan);
    if (!activity && progress.completed >= progress.total) return undefined;
    return { plan, progress };
}

/**
 * The one task the Background work section shows as its whole body, or `undefined` while it needs a header: a single
 * running task and no failure waiting. A header saying `1 running` above that task's own row would only repeat it.
 */
export function agentChatBackgroundWorkSoleTask(
    work: AgentChatBackgroundWork,
): AgentChatTask | undefined {
    return work.running.length === 1 && work.failed.length === 0 ? work.running[0] : undefined;
}

/**
 * The task a folded Background work header names after its count: the latest to start, as a folded Plan names the step
 * in progress, so one row still says what the work is doing.
 */
export function agentChatBackgroundWorkFoldedTask(
    work: AgentChatBackgroundWork,
): AgentChatTask | undefined {
    return work.running.at(-1);
}

/**
 * The Plan section header's accessible name: how far the plan got, and the step in progress when there is one.
 */
export function agentChatPlanProgressLabel(progress: AgentChatPlanProgress, t: Translate): string {
    const { completed, current, total } = progress;
    return current
        ? t('agentChat.plan.progressWithCurrent', { completed, current, total })
        : t('agentChat.plan.progress', { completed, total });
}

/**
 * The Background work header's counts (`1 running · 2 failed`), which its polite live region also announces, so a task
 * failing in the background is heard rather than only drawn. Ticking elapsed times never are.
 */
export function agentChatBackgroundWorkCounts(
    work: AgentChatBackgroundWork,
    t: Translate,
): string[] {
    return [
        work.running.length > 0 &&
            t('agentChat.tasks.runningCount', { count: work.running.length }),
        work.failed.length > 0 && t('agentChat.tasks.failedCount', { count: work.failed.length }),
    ].filter((part): part is string => typeof part === 'string');
}
