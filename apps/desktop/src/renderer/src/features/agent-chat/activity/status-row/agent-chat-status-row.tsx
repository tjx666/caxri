import type { AgentChatActivity } from '@caxri/protocol';

import { AgentChatTurnMetricList } from '../agent-chat-turn-metric-list';
import { AgentChatActivityLead } from './agent-chat-activity-lead';

/**
 * The status row above the composer input while the Chat starts, works, or compacts: Buddy, the turn's verb, and the
 * elapsed time on the left, the turn's usage as bare figures on the right. The plan and background work list in their
 * own collapsible sections above it (`AgentChatComposerStrip`), so this row only ever says what the turn is doing.
 */
export function AgentChatStatusRow({
    activity,
    isStopping,
    turnId,
}: {
    activity: Exclude<AgentChatActivity, { kind: 'waiting' }>;
    isStopping: boolean;
    turnId: string | undefined;
}) {
    return (
        <div
            className="@container flex h-8 items-center gap-2 pr-1.5 pl-3 text-[12px] text-muted"
            data-agent-chat-status-row="activity"
        >
            <AgentChatActivityLead activity={activity} isStopping={isStopping} turnId={turnId} />
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1.5">
                <AgentChatTurnMetricList
                    usage={activity.kind === 'working' ? activity.usage : undefined}
                />
            </span>
        </div>
    );
}
