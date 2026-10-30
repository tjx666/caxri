import type { ReactNode } from 'react';

import type { AgentChatGoal } from '@caxri/protocol';
import { agentChatGoalToggle } from '@caxri/protocol';
import { ChevronRight, Pause, Play, Trash2 } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { agentChatChevronMotion } from '../transcript/agent-chat-disclosure';
import { changeAgentChatGoal } from './agent-chat-goal-commands';

function GoalAction({
    children,
    isExpanded,
    label,
    onClick,
}: {
    children: ReactNode;
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
                aria-expanded={isExpanded}
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
 * The goal row's ghost buttons: Clear, Pause or Resume when the provider offers it, and Expand, which shows the whole
 * objective below the row. Expand is the strip sections' disclosure chevron rather than a maximize glyph, which
 * elsewhere in the app means full screen.
 */
export function AgentChatGoalActions({
    goal,
    isExpanded,
    terminalId,
    onToggleExpanded,
}: {
    goal: AgentChatGoal;
    isExpanded: boolean;
    terminalId: string;
    onToggleExpanded: () => void;
}) {
    const { t } = useTranslation();
    const toggle = agentChatGoalToggle(goal);
    return (
        <div className="ml-1 flex shrink-0 items-center">
            <GoalAction
                label={t('agentChat.goal.clear')}
                onClick={() => changeAgentChatGoal(terminalId, { action: 'clear' })}
            >
                <Trash2 className="size-3.5" />
            </GoalAction>
            {toggle && (
                <GoalAction
                    label={t(toggle === 'pause' ? 'agentChat.goal.pause' : 'agentChat.goal.resume')}
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
