import type { ReactNode } from 'react';
import { useState } from 'react';

import type { AgentChatGoal } from '@caxri/protocol';
import { agentChatGoalToggle } from '@caxri/protocol';
import { ChevronRight, CircleSlash, Pause, Play } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { agentChatChevronMotion } from '../transcript/agent-chat-disclosure';
import { agentChatGoalClearLabelKey, changeAgentChatGoal } from './agent-chat-goal-commands';

function GoalAction({
    children,
    isBusy,
    isExpanded,
    label,
    onClick,
}: {
    children: ReactNode;
    /**
     * Set while this button's goal change is in flight: the button shows a spinner and ignores clicks.
     */
    isBusy?: boolean;
    /**
     * Set only on the Expand toggle, which discloses the objective below the row.
     */
    isExpanded?: boolean;
    label: string;
    onClick: () => void;
}) {
    return (
        <Tooltip content={label}>
            <Button
                aria-busy={isBusy}
                aria-expanded={isExpanded}
                aria-label={label}
                className="size-6 shrink-0 text-muted hover:text-foreground"
                size="icon"
                variant="ghost"
                onClick={isBusy ? undefined : onClick}
            >
                {isBusy ? <Spinner className="size-3.5" role="presentation" /> : children}
            </Button>
        </Tooltip>
    );
}

/**
 * The goal row's ghost buttons: Pause or Resume when the provider offers it, Clear, and Expand, which shows the whole
 * objective below the row. Expand is the strip sections' disclosure chevron rather than a maximize glyph, which
 * elsewhere in the app means full screen.
 */
export function AgentChatGoalActions({
    goal,
    isExpanded,
    isTurnRunning,
    terminalId,
    onToggleExpanded,
}: {
    goal: AgentChatGoal;
    isExpanded: boolean;
    /**
     * Whether a turn is running, which a Claude Code clear stops first.
     */
    isTurnRunning: boolean;
    terminalId: string;
    onToggleExpanded: () => void;
}) {
    const { t } = useTranslation();
    const toggle = agentChatGoalToggle(goal);
    const [pending, setPending] = useState<'clear' | 'pause' | 'resume'>();
    const run = (action: 'clear' | 'pause' | 'resume') => {
        if (pending) return;
        setPending(action);
        void changeAgentChatGoal(terminalId, { action }).finally(() => setPending(undefined));
    };
    return (
        <div className="ml-1 flex shrink-0 items-center">
            {toggle && (
                <GoalAction
                    label={t(toggle === 'pause' ? 'agentChat.goal.pause' : 'agentChat.goal.resume')}
                    isBusy={pending === toggle}
                    onClick={() => run(toggle)}
                >
                    {toggle === 'pause' ? (
                        <Pause className="size-3.5" />
                    ) : (
                        <Play className="size-3.5" />
                    )}
                </GoalAction>
            )}
            <GoalAction
                isBusy={pending === 'clear'}
                label={t(agentChatGoalClearLabelKey(goal, isTurnRunning))}
                onClick={() => run('clear')}
            >
                <CircleSlash className="size-3.5" />
            </GoalAction>
            <GoalAction
                isExpanded={isExpanded}
                label={t(isExpanded ? 'agentChat.goal.collapse' : 'agentChat.goal.expand')}
                onClick={onToggleExpanded}
            >
                <ChevronRight
                    className={cn(
                        'size-3.5',
                        agentChatChevronMotion(isExpanded),
                        isExpanded && 'rotate-90',
                    )}
                />
            </GoalAction>
        </div>
    );
}
