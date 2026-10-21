import type { ReactNode } from 'react';
import { useState } from 'react';

import type { AgentChatGoal, AgentChatTurn } from '@caxri/protocol';
import {
    agentChatGoalElapsedSeconds,
    agentChatGoalToggle,
    formatAgentChatGoalDuration,
} from '@caxri/protocol';
import { Goal, Maximize2, Minimize2, Pause, Play, Trash2 } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { changeAgentChatGoal } from '../agent-chat-commands';
import { useClockTick } from '../hooks/use-clock-tick';

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
    const now = useClockTick('second');
    return (
        <>{formatAgentChatGoalDuration(agentChatGoalElapsedSeconds(goal, now, turnStartedAt))}</>
    );
}

function GoalAction({
    children,
    label,
    onClick,
}: {
    children: ReactNode;
    label: string;
    onClick: () => void;
}) {
    return (
        <Tooltip content={label}>
            <Button
                aria-label={label}
                className="size-6 shrink-0 text-muted hover:text-foreground"
                size="icon"
                variant="ghost"
                onClick={onClick}
            >
                {children}
            </Button>
        </Tooltip>
    );
}

/**
 * The composer strip's goal row, after the Codex app's: while the provider pursues a goal across turns, it shows where
 * the goal stands, the objective, and how long it has been worked on, with Clear, Pause or Resume, and Expand, which
 * shows the whole objective below the row. The time ticks only while an active goal's turn runs, since the provider
 * counts no time otherwise. A completed goal stays until cleared, so its outcome is not lost when the turn ends.
 */
export function AgentChatGoalBar({
    activeTurnId,
    goal,
    terminalId,
    turns,
}: {
    /**
     * The running turn, or `undefined` while no turn runs.
     */
    activeTurnId: string | undefined;
    goal: AgentChatGoal | undefined;
    terminalId: string;
    turns: ReadonlyArray<Pick<AgentChatTurn, 'id' | 'startedAt'>> | undefined;
}) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    if (!goal) return null;
    const runningTurnStartedAt =
        activeTurnId === undefined
            ? undefined
            : turns?.find((turn) => turn.id === activeTurnId)?.startedAt;
    const toggle = agentChatGoalToggle(goal);
    const isActive = goal.status === 'active';
    return (
        <div
            className="border-0 border-b border-solid border-border text-[12px]"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-goal={goal.status}
        >
            <div className="flex h-8 items-center gap-2 pr-1.5 pl-3">
                <Goal
                    aria-hidden="true"
                    className={cn('size-3.5 shrink-0', isActive ? 'text-accent' : 'text-muted')}
                />
                <span className="shrink-0 font-medium text-foreground">
                    {t(STATUS_LABELS[goal.status])}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted">{goal.objective}</span>
                <span className="shrink-0 text-muted tabular-nums">
                    {isActive && runningTurnStartedAt !== undefined ? (
                        <TickingGoalTime goal={goal} turnStartedAt={runningTurnStartedAt} />
                    ) : (
                        formatAgentChatGoalDuration(goal.timeUsedSeconds)
                    )}
                </span>
                <div className="flex shrink-0 items-center">
                    <GoalAction
                        label={t('agentChat.goal.clear')}
                        onClick={() => changeAgentChatGoal(terminalId, { action: 'clear' })}
                    >
                        <Trash2 className="size-3.5" />
                    </GoalAction>
                    {toggle && (
                        <GoalAction
                            label={t(
                                toggle === 'pause'
                                    ? 'agentChat.goal.pause'
                                    : 'agentChat.goal.resume',
                            )}
                            onClick={() => changeAgentChatGoal(terminalId, { action: toggle })}
                        >
                            {toggle === 'pause' ? (
                                <Pause className="size-3.5" />
                            ) : (
                                <Play className="size-3.5" />
                            )}
                        </GoalAction>
                    )}
                    <GoalAction
                        label={t(isExpanded ? 'agentChat.goal.collapse' : 'agentChat.goal.expand')}
                        onClick={() => setExpanded((current) => !current)}
                    >
                        {isExpanded ? (
                            <Minimize2 className="size-3.5" />
                        ) : (
                            <Maximize2 className="size-3.5" />
                        )}
                    </GoalAction>
                </div>
            </div>
            {isExpanded && (
                <p className="m-0 max-h-40 overflow-y-auto px-3 pb-2 leading-5 wrap-anywhere whitespace-pre-wrap text-foreground">
                    {goal.objective}
                </p>
            )}
        </div>
    );
}
