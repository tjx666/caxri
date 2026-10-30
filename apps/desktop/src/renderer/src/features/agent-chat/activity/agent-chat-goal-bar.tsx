import { useState } from 'react';

import type { AgentChatGoal, AgentChatGoalUsage, AgentChatTurn } from '@caxri/protocol';
import { agentChatGoalElapsedSeconds, formatAgentChatGoalDuration } from '@caxri/protocol';
import { Goal } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { goalTimeFigures } from './agent-chat-elapsed-time';
import { AgentChatGoalActions } from './agent-chat-goal-actions';
import type { AgentChatWorkingActivity } from './agent-chat-goal-row';
import { agentChatGoalSpend } from './agent-chat-goal-row';
import { AgentChatRollingTime } from './agent-chat-rolling-time';
import { AgentChatTurnMetricList } from './agent-chat-turn-metric-list';

const STATUS_LABELS = {
    active: 'agentChat.goal.status.active',
    paused: 'agentChat.goal.status.paused',
    blocked: 'agentChat.goal.status.blocked',
    usageLimited: 'agentChat.goal.status.usageLimited',
    budgetLimited: 'agentChat.goal.status.budgetLimited',
    complete: 'agentChat.goal.status.complete',
} as const satisfies Record<AgentChatGoal['status'], TranslationKey>;

/**
 * The goal's time, ticking each second while a turn works on it. Mounted only then, so an idle goal re-renders nothing.
 */
function TickingGoalTime({ goal, turnStartedAt }: { goal: AgentChatGoal; turnStartedAt: number }) {
    const { t } = useTranslation();
    const now = useClockTick('second');
    return (
        <AgentChatRollingTime
            data-agent-chat-goal-time=""
            figures={goalTimeFigures(agentChatGoalElapsedSeconds(goal, now, turnStartedAt), t)}
        />
    );
}

/**
 * The goal glyph that leads the row, `--accent` while the goal is active. While a turn works on the goal (`step` is
 * set), a ring ripples out of it once for each model request the goal makes, so the row shows the goal advancing step
 * by step rather than looping on its own (DESIGN.md "Motion": replay on a real trigger). Reduced motion keeps it
 * still.
 */
function GoalGlyph({ goal, step }: { goal: AgentChatGoal; step: number | undefined }) {
    return (
        <span className="relative inline-flex shrink-0">
            {step !== undefined && (
                <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full border border-accent opacity-75 motion-safe:animate-ping motion-safe:[animation-fill-mode:forwards] motion-safe:[animation-iteration-count:1] motion-reduce:hidden"
                    data-agent-chat-goal-ripple=""
                    key={step}
                />
            )}
            <Goal
                aria-hidden="true"
                className={cn('size-3.5', goal.status === 'active' ? 'text-accent' : 'text-muted')}
            />
        </span>
    );
}

/**
 * The composer strip's goal row, after the Codex app's: while the provider pursues a goal across turns, it shows the
 * objective, how long it has been worked on, and what it has spent, with Clear, Pause or Resume, and Expand. While a
 * turn works on the goal the row is the Chat's live state, in place of the status row (`agentChatLiveGoalActivity`):
 * the glyph ripples with each step, the objective carries the working text's sweep, and the time and figures count the
 * whole goal, so they keep growing when the provider starts its next turn. The glyph stays between the provider's
 * turns, so the row does not swap its lead each time one ends and the next begins. A goal that is not active names its
 * status, since nothing else on screen says it stopped. A completed goal stays until cleared, so its outcome is not
 * lost when the turn ends.
 */
export function AgentChatGoalBar({
    goal,
    goalUsage,
    liveActivity,
    terminalId,
    turnId,
    turns,
}: {
    goal: AgentChatGoal | undefined;
    goalUsage: AgentChatGoalUsage | undefined;
    /**
     * The turn working on the goal, which the row shows live, or `undefined`.
     */
    liveActivity: AgentChatWorkingActivity | undefined;
    terminalId: string;
    /**
     * The running turn, or `undefined` while no turn runs.
     */
    turnId: string | undefined;
    turns: ReadonlyArray<Pick<AgentChatTurn, 'id' | 'startedAt'>> | undefined;
}) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    if (!goal) return null;
    const runningTurnStartedAt =
        turnId === undefined ? undefined : turns?.find((turn) => turn.id === turnId)?.startedAt;
    const isActive = goal.status === 'active';
    const spend = agentChatGoalSpend(goal, goalUsage);
    return (
        <div
            className="border-0 border-b border-solid border-border text-[12px]"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-goal={goal.status}
            data-agent-chat-goal-live={liveActivity ? '' : undefined}
        >
            <div className="@container flex h-8 items-center gap-2.5 pr-1.5 pl-3">
                <GoalGlyph goal={goal} step={liveActivity ? (spend?.requests ?? 0) : undefined} />
                {!isActive && (
                    <span className="shrink-0 font-medium text-foreground">
                        {t(STATUS_LABELS[goal.status])}
                    </span>
                )}
                <span className="min-w-0 flex-1 truncate text-muted">
                    <span className={liveActivity ? 'activity-shimmer' : undefined}>
                        {goal.objective}
                    </span>
                </span>
                <span className="shrink-0 text-muted tabular-nums">
                    {isActive && runningTurnStartedAt !== undefined ? (
                        <TickingGoalTime goal={goal} turnStartedAt={runningTurnStartedAt} />
                    ) : (
                        formatAgentChatGoalDuration(goal.timeUsedSeconds, t)
                    )}
                </span>
                <span className="flex shrink-0 items-center text-muted">
                    <AgentChatTurnMetricList hasLeadingDivider scope="goal" usage={spend} />
                </span>
                <AgentChatGoalActions
                    goal={goal}
                    isExpanded={isExpanded}
                    isTurnRunning={turnId !== undefined}
                    terminalId={terminalId}
                    onToggleExpanded={() => setExpanded((current) => !current)}
                />
            </div>
            {isExpanded && (
                <p className="m-0 max-h-40 overflow-y-auto px-3 pb-2 leading-5 wrap-anywhere whitespace-pre-wrap text-foreground">
                    {goal.objective}
                </p>
            )}
        </div>
    );
}
