import type { AgentChatActivity, AgentChatSnapshot } from '@caxri/protocol';

import { AgentChatActivityBar } from '../activity/agent-chat-activity-bar';
import { useIsAgentChatDeliveryHintShown } from '../activity/agent-chat-delivery-hint';
import { AgentChatContextAlerts } from '../context/agent-chat-context-alerts';
import { AgentChatPlanPaceAlert } from '../tools/agent-chat-plan-pace-alert';
import { agentChatDeliveryHint } from '../transcript/agent-chat-presentation';
import type { AgentChatEditBarProperties } from './agent-chat-edit-bar';
import { AgentChatEditBar } from './agent-chat-edit-bar';

/**
 * The rows stacked above the composer's input: the activity tab, the edit bar, and the context and plan alerts. The
 * alerts give way to the activity row and the edit bar, which own the strip while they show.
 */
export function AgentChatComposerNotices({
    activeTurnId,
    activity,
    edit,
    isContinuing,
    isDrafting,
    isEditing,
    isSteerDefault,
    notice,
    onCompact,
    onContinueInNewChat,
    terminalId,
    usage,
}: {
    activeTurnId: string | undefined;
    activity: AgentChatActivity | undefined;
    edit: AgentChatEditBarProperties | undefined;
    isContinuing: boolean;
    /**
     * Whether the input holds a draft; during a running turn the activity row then says what Enter does with it. The
     * queue and steer shortcuts show only until the user learned them (`useIsAgentChatDeliveryHintShown`); Enter
     * steering while the Agent waits on subagents (`isSteerDefault`) always says so, because it breaks the usual
     * queueing rule.
     */
    isDrafting: boolean;
    isEditing: boolean;
    isSteerDefault: boolean;
    notice: string | undefined;
    onCompact: (() => void) | undefined;
    onContinueInNewChat: () => void;
    terminalId: string;
    usage: AgentChatSnapshot['usage'] | undefined;
}) {
    const hasStripRoom = !activity && !isEditing;
    const deliveryHint = agentChatDeliveryHint({
        hasDraft: isDrafting,
        isSteerDefault,
        isTurnRunning: activeTurnId !== undefined,
    });
    const showsQueueHint = useIsAgentChatDeliveryHintShown(
        activeTurnId,
        deliveryHint === 'queueOrSteer',
    );
    const shownHint = deliveryHint === 'steer' || showsQueueHint ? deliveryHint : undefined;
    return (
        <>
            <AgentChatActivityBar
                activity={activity}
                notice={notice}
                deliveryHint={shownHint}
                terminalId={terminalId}
                turnId={activeTurnId}
            />
            <AgentChatEditBar edit={edit} />
            <AgentChatContextAlerts
                isContinuing={isContinuing}
                isShown={hasStripRoom}
                usage={usage}
                onCompact={onCompact}
                onContinueInNewChat={onContinueInNewChat}
                terminalId={terminalId}
            />
            <AgentChatPlanPaceAlert isShown={hasStripRoom} terminalId={terminalId} />
        </>
    );
}
