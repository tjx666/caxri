import type { AgentChatGoal, AgentChatSnapshot } from '@caxri/protocol';
import {
    agentChatGoalElapsedSeconds,
    agentChatGoalToggle,
    formatAgentChatGoalDuration,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

const STATUS_LABELS = {
    active: 'chat.goal.status.active',
    paused: 'chat.goal.status.paused',
    blocked: 'chat.goal.status.blocked',
    usageLimited: 'chat.goal.status.usageLimited',
    budgetLimited: 'chat.goal.status.budgetLimited',
    complete: 'chat.goal.status.complete',
} as const satisfies Record<AgentChatGoal['status'], TranslationKey>;

/**
 * What the goal bar above the phone's composer shows, worded as Desktop's goal row (`AgentChatGoalBar`).
 */
export interface AgentChatGoalBarView {
    /**
     * `Pursuing goal`, `Goal paused`, and so on.
     */
    status: string;
    objective: string;
    /**
     * Time worked on the goal (`12m 5s`).
     */
    elapsed: string;
    isActive: boolean;
    /**
     * Whether the goal's time still counts up, so the bar needs a clock.
     */
    isTicking: boolean;
    /**
     * Which of Pause and Resume the goal offers, `undefined` when it can only be cleared.
     */
    toggle: 'pause' | 'resume' | undefined;
}

/**
 * When the running turn began, for the goal's live time; `undefined` while no turn runs.
 */
export const agentChatRunningTurnStartedAt = (
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'turns'>,
): number | undefined =>
    snapshot.activeTurnId === undefined
        ? undefined
        : snapshot.turns.find((turn) => turn.id === snapshot.activeTurnId)?.startedAt;

/**
 * The goal bar for a Chat, or `undefined` when it has no goal. A saved copy shows none: its goal may have ended long
 * ago, and its buttons could not reach the Agent.
 */
export const agentChatGoalBarView = (
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'goal' | 'turns'> | undefined,
    now: number,
    isSavedCopy: boolean,
    t: Translate = translate,
): AgentChatGoalBarView | undefined => {
    const goal = snapshot?.goal;
    if (!snapshot || !goal || isSavedCopy) return undefined;
    const turnStartedAt = agentChatRunningTurnStartedAt(snapshot);
    const isActive = goal.status === 'active';
    return {
        status: t(STATUS_LABELS[goal.status]),
        objective: goal.objective,
        elapsed: formatAgentChatGoalDuration(agentChatGoalElapsedSeconds(goal, now, turnStartedAt)),
        isActive,
        isTicking: isActive && turnStartedAt !== undefined,
        toggle: agentChatGoalToggle(goal),
    };
};
