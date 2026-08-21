import type { AgentActivityState, AgentOperation } from '@shared/types';
import { Circle } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { sessionActivityPresentation } from './session-activity';

/**
 * The activity dot every Session row wears, wherever that row is rendered (Sidebar tree, MRU switcher).
 *
 * One component rather than one hand-rolled `Circle` per surface is what makes a Session recognizable across surfaces:
 * the same glyph, the same tone table, and the same accessible name.
 */
export function SessionActivityDot({
    agentOperation,
    className,
    size = 7,
    state,
}: {
    /**
     * What the Agent is doing right now, when the Session has a live Terminal to report it. It outranks the activity
     * state — a compacting Agent reads as compacting, not as running.
     */
    agentOperation?: AgentOperation;
    className?: string;
    size?: number;
    state: AgentActivityState;
}) {
    const activity = sessionActivityPresentation(state, agentOperation);
    return (
        <span
            role="img"
            aria-label={activity.ariaLabel}
            title={activity.label}
            className={cn(
                `activity activity-${state}`,
                'flex flex-none items-center',
                activity.indicatorClassName,
                className,
            )}
            data-agent-operation={agentOperation}
        >
            <Circle size={size} fill="currentColor" />
        </span>
    );
}
