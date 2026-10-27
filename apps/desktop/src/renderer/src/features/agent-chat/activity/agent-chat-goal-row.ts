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
