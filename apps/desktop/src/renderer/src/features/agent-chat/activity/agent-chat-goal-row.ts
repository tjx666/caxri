import type { AgentChatActivity, AgentChatGoal, AgentChatGoalUsage } from '@caxri/protocol';

export type AgentChatWorkingActivity = Extract<AgentChatActivity, { kind: 'working' }>;

/**
 * The work the goal row shows live in place of the status row: a turn working on an active goal. The provider starts
 * such turns on its own, so the user follows the goal rather than any one turn, and a separate status row would only
 * repeat it with a second clock and figures that start over each turn. A turn being stopped, compacting, or waiting on
 * the user keeps its own row, since that state is about the turn.
 */
export function agentChatLiveGoalActivity(
    goal: Pick<AgentChatGoal, 'status'> | undefined,
    activity: AgentChatActivity | undefined,
    isStopping: boolean,
): AgentChatWorkingActivity | undefined {
    if (isStopping || goal?.status !== 'active' || activity?.kind !== 'working') return undefined;
    return activity;
}

/**
 * What the goal has spent across its turns, or `undefined` while Server Core has counted nothing for this goal (its
 * figures name another objective).
 */
export function agentChatGoalSpend(
    goal: Pick<AgentChatGoal, 'objective'>,
    usage: AgentChatGoalUsage | undefined,
): AgentChatGoalUsage | undefined {
    return usage?.objective === goal.objective ? usage : undefined;
}

/**
 * Identity of a goal outcome whose reason should open by itself: a goal that ended `failed`, `blocked`, or
 * `budgetLimited` with a provider reason. The row expands once per key, so a later manual collapse is not undone;
 * `undefined` for every other goal.
 */
export function agentChatGoalAutoExpandKey(
    goal: Pick<AgentChatGoal, 'objective' | 'reason' | 'status'>,
): string | undefined {
    const isUnfinished = ['failed', 'blocked', 'budgetLimited'].includes(goal.status);
    return isUnfinished && goal.reason ? `${goal.status}:${goal.objective}` : undefined;
}
