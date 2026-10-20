import type { AgentChatActivity, AgentChatSnapshot } from '@caxri/protocol';

import { AgentChatActivityBar } from './agent-chat-activity-bar';
import { AgentChatContextAlerts } from './agent-chat-context-alerts';
import type { AgentChatEditBarProperties } from './agent-chat-edit-bar';
import { AgentChatEditBar } from './agent-chat-edit-bar';
import { AgentChatPlanPaceAlert } from './agent-chat-plan-pace-alert';

/**
 * The rows stacked above the composer's input: the activity tab, the edit bar, and the context and plan alerts. The
 * alerts give way to the activity row and the edit bar, which own the strip while they show.
 */
export function AgentChatComposerNotices({
    activeTurnId,
    activity,
    delivery,
    edit,
    isContinuing,
    isEditing,
    notice,
    onCompact,
    onContinueInNewChat,
    onStop,
    terminalId,
    usage,
}: {
    activeTurnId: string | undefined;
    activity: AgentChatActivity | undefined;
    /**
     * Whether a draft typed during a running turn is being steered into it, which the activity row hints at.
     */
    delivery: boolean;
    edit: AgentChatEditBarProperties | undefined;
    isContinuing: boolean;
    isEditing: boolean;
    notice: string | undefined;
    onCompact: (() => void) | undefined;
    onContinueInNewChat: () => void;
    onStop: () => void;
    terminalId: string;
    usage: AgentChatSnapshot['usage'] | undefined;
}) {
    const hasStripRoom = !activity && !isEditing;
    return (
        <>
            <AgentChatActivityBar
                activity={activity}
                notice={notice}
                showsDeliveryHint={delivery}
                terminalId={terminalId}
                turnId={activeTurnId}
                onStop={onStop}
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
