import type { AgentChatActivity, AgentChatSnapshot } from '@caxri/protocol';

import { AgentChatActivityBar } from '../activity/agent-chat-activity-bar';
import { AgentChatContextAlerts } from '../context/agent-chat-context-alerts';
import { AgentChatPlanPaceAlert } from '../tools/agent-chat-plan-pace-alert';
import type { AgentChatEditBarProperties } from './agent-chat-edit-bar';
import { AgentChatEditBar } from './agent-chat-edit-bar';

/**
 * The rows stacked above the composer's input: the status row, the edit bar, and the context and plan alerts. The
 * alerts give way to a busy Chat and the edit bar, which own the strip while they show.
 */
export function AgentChatComposerNotices({
    activeTurnId,
    activity,
    edit,
    isContinuing,
    isEditing,
    notice,
    onCompact,
    onContinueInNewChat,
    onOpenTask,
    onPopoverClosed,
    snapshot,
    terminalId,
}: {
    activeTurnId: string | undefined;
    activity: AgentChatActivity | undefined;
    edit: AgentChatEditBarProperties | undefined;
    isContinuing: boolean;
    isEditing: boolean;
    notice: string | undefined;
    onCompact: (() => void) | undefined;
    onContinueInNewChat: () => void;
    onOpenTask: ((taskId: string) => void) | undefined;
    onPopoverClosed: () => HTMLElement | null;
    snapshot: Pick<AgentChatSnapshot, 'plan' | 'tasks' | 'turns' | 'usage'> | undefined;
    terminalId: string;
}) {
    const hasStripRoom = !activity && !isEditing;
    return (
        <>
            <AgentChatActivityBar
                activity={activity}
                notice={notice}
                snapshot={snapshot}
                terminalId={terminalId}
                turnId={activeTurnId}
                onOpenTask={onOpenTask}
                onPopoverClosed={onPopoverClosed}
            />
            <AgentChatEditBar edit={edit} />
            <AgentChatContextAlerts
                isContinuing={isContinuing}
                isShown={hasStripRoom}
                usage={snapshot?.usage}
                onCompact={onCompact}
                onContinueInNewChat={onContinueInNewChat}
                terminalId={terminalId}
            />
            <AgentChatPlanPaceAlert isShown={hasStripRoom} terminalId={terminalId} />
        </>
    );
}
