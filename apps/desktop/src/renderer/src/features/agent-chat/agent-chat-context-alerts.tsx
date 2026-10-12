import type { AgentChatUsage } from '@caxri/protocol';
import { Gauge, MessageSquarePlus, Timer, TimerOff } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { agentChatContextAlerts } from './agent-chat-context';
import { useClockTick } from './hooks/use-clock-tick';

/**
 * Both of the row's actions share one Button shape, so neither reads as the lesser choice by styling alone.
 */
const ACTION_CLASS = 'min-h-6 shrink-0 gap-1.5 px-1.5 text-[12px]';

/**
 * The composer's first row while an idle Chat's context needs attention: the prompt cache is about to expire
 * (`--warning`: still avoidable by replying now), the cache expired, so the next reply re-reads the whole conversation
 * (`--muted`: a cost fact, not a fault), or the context is high enough to compact first (`--danger`, with a Compact
 * button when the provider reports a compact command). It takes the activity bar's place and shape, so it is hidden
 * while a turn runs, when neither notice is actionable. Expiry is judged on a minute clock, which only runs while a
 * Chat with usage shows the composer. An expired cache also offers to continue in a new Chat, which reads the old
 * transcript through a cheap subagent instead of rewriting it.
 */
export function AgentChatContextAlerts({
    isContinuing,
    onCompact,
    onContinueInNewChat,
    usage,
}: {
    /**
     * True while the new Chat is being opened; the button dims and the handler ignores further clicks.
     */
    isContinuing: boolean;
    /**
     * Runs the provider's compact command; omitted when the provider reports none.
     */
    onCompact: (() => void) | undefined;
    onContinueInNewChat: () => void;
    usage: AgentChatUsage;
}) {
    const { t } = useTranslation();
    const alerts = agentChatContextAlerts(usage, useClockTick('minute'));
    if (!alerts.cache && !alerts.pressure) return null;
    const canCompact = alerts.pressure !== undefined && onCompact !== undefined;
    const isExpired = alerts.cache?.state === 'expired';
    return (
        <div
            className="flex h-8 min-w-0 items-center gap-3 border-0 border-b border-solid border-border px-3 text-[12px]"
            data-agent-chat-composer-strip-row=""
            role="status"
        >
            {alerts.cache && (
                <span
                    className={cn(
                        'flex min-w-0 items-center gap-2',
                        isExpired ? 'text-muted' : 'text-warning',
                    )}
                    data-agent-chat-cache-alert={alerts.cache.state}
                >
                    {isExpired ? (
                        <TimerOff aria-hidden className="size-3.5 shrink-0" />
                    ) : (
                        <Timer aria-hidden className="size-3.5 shrink-0" />
                    )}
                    <Tooltip content={alerts.cache.detail}>
                        <span className="truncate">{alerts.cache.text}</span>
                    </Tooltip>
                </span>
            )}
            {alerts.cache && alerts.pressure && (
                <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
            )}
            {alerts.pressure && (
                <span className="flex min-w-0 items-center gap-2 text-danger">
                    <Gauge aria-hidden className="size-3.5 shrink-0" />
                    <Tooltip content={alerts.pressure.detail}>
                        <span className="truncate">{alerts.pressure.text}</span>
                    </Tooltip>
                </span>
            )}
            {(isExpired || canCompact) && (
                <span className="-mr-1.5 ml-auto flex shrink-0 items-center gap-1">
                    {isExpired && (
                        <Tooltip content={t('agentChat.context.continueTooltip')}>
                            <Button
                                aria-disabled={isContinuing || undefined}
                                className={ACTION_CLASS}
                                size="sm"
                                variant="secondary"
                                onClick={onContinueInNewChat}
                            >
                                <MessageSquarePlus aria-hidden className="size-3.5" />
                                {t('agentChat.context.continueInNewChat')}
                            </Button>
                        </Tooltip>
                    )}
                    {canCompact && (
                        <Button
                            className={ACTION_CLASS}
                            size="sm"
                            variant="secondary"
                            onClick={onCompact}
                        >
                            {t('agentChat.context.compact')}
                        </Button>
                    )}
                </span>
            )}
        </div>
    );
}
