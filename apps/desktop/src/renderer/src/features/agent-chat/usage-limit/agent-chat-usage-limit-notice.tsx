import type { AgentChatItem } from '@caxri/protocol';
import { agentChatNoticeMessage } from '@caxri/protocol';
import { Gauge } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { localizedLimitReset } from '../../../lib/usage-format';
import { useTerminal } from '../../../stores/selectors';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { AgentChatAutoContinueActions } from './agent-chat-auto-continue-actions';
import { AgentChatAutoContinueLine } from './agent-chat-auto-continue-line';
import { agentChatUsageLimitHeadline } from './agent-chat-continuation';
import { AgentChatContinueInAgent } from './agent-chat-continue-in-agent';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * A turn the provider failed because the plan's usage limit is used up (issue #2581): which window ran out and when it
 * resets, the provider's own words muted beneath, and the ways forward: the Chat continuing on its own once the limit
 * resets (issue #2220), with Continue now and Cancel, and continuing in another Agent. The composer stays usable, and
 * sending anything ends the wait. Once the Chat continued on its own, the other Agent is no longer offered. A task
 * tab's read-only timeline has no Terminal, so it shows the failure without the actions. A notice a later failed turn
 * superseded collapses to its muted headline.
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
    // Once the reset passed, "resets now" would stay on the notice for good.
    const reset =
        usageLimit.resetsAt === undefined || usageLimit.resetsAt <= now
            ? undefined
            : localizedLimitReset(usageLimit.resetsAt, now, t);
    const detail = agentChatNoticeMessage(item, t);
    const headline =
        usageLimit.trigger === 'usageGuard'
            ? t('agentChat.usageLimit.guardStopped', { provider: providerName })
            : agentChatUsageLimitHeadline(usageLimit, providerName, t);
    // A later turn failed on the limit too and carries the wait: this one is only a line in the history.
    if (usageLimit.superseded)
        return (
            <div
                className="flex items-center gap-2 text-[12px] leading-5 text-muted"
                data-agent-chat-usage-limit={usageLimit.window}
                data-superseded=""
            >
                <Gauge aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate select-text">{headline}</span>
            </div>
        );
    return (
        <div
            className="flex items-start gap-2 text-[12px] leading-5"
            data-agent-chat-usage-limit={usageLimit.window}
        >
            <Gauge aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-1.5 select-text">
                <div className="text-danger">
                    {headline}
                    {reset && <span className="text-muted"> · {reset}</span>}
                </div>
                {detail && usageLimit.trigger !== 'usageGuard' && (
                    <div className="wrap-anywhere whitespace-pre-line text-muted">{detail}</div>
                )}
                {usageLimit.autoContinue && (
                    <AgentChatAutoContinueLine autoContinue={usageLimit.autoContinue} />
                )}
                {terminalId && item.turnId && usageLimit.autoContinue?.status !== 'continued' && (
                    <div className="flex flex-wrap items-center gap-1.5 select-none">
                        <AgentChatAutoContinueActions
                            autoContinue={usageLimit.autoContinue}
                            terminalId={terminalId}
                            turnId={item.turnId}
                        />
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
