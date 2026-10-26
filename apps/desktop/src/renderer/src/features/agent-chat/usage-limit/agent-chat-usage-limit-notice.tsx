import type { AgentChatItem } from '@caxri/protocol';
import { agentChatNoticeMessage } from '@caxri/protocol';
import { Gauge } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { localizedLimitReset } from '../../../lib/usage-format';
import { useTerminal } from '../../../stores/selectors';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { useClockTick } from '../hooks/use-clock-tick';
import { agentChatUsageLimitHeadline } from './agent-chat-continuation';
import { AgentChatContinueInAgent } from './agent-chat-continue-in-agent';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * A turn the provider failed because the plan's usage limit is used up (issue #2581): which window ran out and when it
 * resets, the provider's own words muted beneath, and the way forward, continuing in another Agent. Waiting for the
 * reset needs no control; the composer stays usable. A task tab's read-only timeline has no Terminal, so it shows the
 * failure without the action.
 */
export function AgentChatUsageLimitNotice({
    item,
    usageLimit,
}: {
    item: Notice;
    usageLimit: NonNullable<Notice['usageLimit']>;
}) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    const terminalId = useAgentChatTerminal();
    const provider = useTerminal(terminalId ?? '')?.kind;
    const providerName = resolveAgentIcon(provider).label;
    const reset =
        usageLimit.resetsAt === undefined
            ? undefined
            : localizedLimitReset(usageLimit.resetsAt, now, t);
    const detail = agentChatNoticeMessage(item, t);
    return (
        <div
            className="flex items-start gap-2 text-[12px] leading-5"
            data-agent-chat-usage-limit={usageLimit.window}
        >
            <Gauge aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-1.5 select-text">
                <div className="text-danger">
                    {agentChatUsageLimitHeadline(usageLimit, providerName, t)}
                    {reset && <span className="text-muted"> · {reset}</span>}
                </div>
                {detail && (
                    <div className="wrap-anywhere whitespace-pre-line text-muted">{detail}</div>
                )}
                {terminalId && item.turnId && (
                    <div className="flex select-none">
                        <AgentChatContinueInAgent
                            continuedIn={usageLimit.continuedIn}
                            terminalId={terminalId}
                            turnId={item.turnId}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
