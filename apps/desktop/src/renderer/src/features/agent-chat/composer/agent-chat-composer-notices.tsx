import type { AgentChatActivity, AgentChatSnapshot } from '@caxri/protocol';

import { AgentChatActivityBar } from '../activity/agent-chat-activity-bar';
import { AgentChatContextAlerts } from '../context/agent-chat-context-alerts';
import { AgentChatPlanPaceAlert } from '../tools/agent-chat-plan-pace-alert';
import { AgentChatCreditsNotice } from '../usage-limit/agent-chat-credits-notice';
import { AgentChatUsageGuardCard } from '../usage-limit/agent-chat-usage-guard-card';
import type { AgentChatEditBarProperties } from './agent-chat-edit-bar';
import { AgentChatEditBar } from './agent-chat-edit-bar';

/**
 * The rows stacked above the composer's input: the status row, the edit bar, the usage guard or its credits notice, and
 * the context and plan alerts. The alerts give way to a busy Chat and the edit bar, which own the strip while they
 * show, and to the usage guard, which refuses the compaction and new Chat they offer.
 */
export function AgentChatComposerNotices({
    activeTurnId,
    activity,
    edit,
    isActivityInGoalRow,
    isContinuing,
    isEditing,
    notice,
    onCompact,
    onContinueInNewChat,
    snapshot,
    terminalId,
}: {
    activeTurnId: string | undefined;
    activity: AgentChatActivity | undefined;
    edit: AgentChatEditBarProperties | undefined;
    /**
     * Whether the goal row shows the running turn's work in place of the status row.
     */
    isActivityInGoalRow: boolean;
    isContinuing: boolean;
    isEditing: boolean;
    notice: string | undefined;
    onCompact: (() => void) | undefined;
    onContinueInNewChat: () => void;
    snapshot:
        | Pick<AgentChatSnapshot, 'idleCompactionHold' | 'items' | 'usage' | 'usageGuard'>
        | undefined;
    terminalId: string;
}) {
    const guard = snapshot?.usageGuard;
    const hasStripRoom = !activity && !isEditing && !guard;
    return (
        <>
            <AgentChatActivityBar
                activity={activity}
                isInGoalRow={isActivityInGoalRow}
                notice={notice}
                terminalId={terminalId}
                turnId={activeTurnId}
            />
            <AgentChatEditBar edit={edit} />
            {guard && <AgentChatUsageGuardCard guard={guard} terminalId={terminalId} />}
            <AgentChatContextAlerts
                idleCompactionHold={snapshot?.idleCompactionHold}
                isContinuing={isContinuing}
                isShown={hasStripRoom}
                items={snapshot?.items}
                usage={snapshot?.usage}
                onCompact={onCompact}
                onContinueInNewChat={onContinueInNewChat}
                terminalId={terminalId}
            />
            <AgentChatCreditsNotice isShown={hasStripRoom} terminalId={terminalId} />
            <AgentChatPlanPaceAlert isShown={hasStripRoom} terminalId={terminalId} />
        </>
    );
}
