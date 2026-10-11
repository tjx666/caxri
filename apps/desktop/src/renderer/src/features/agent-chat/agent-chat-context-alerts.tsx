import type { AgentChatUsage } from '@caxri/protocol';
import { Gauge, MessageSquarePlus, TimerOff } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { agentChatContextAlerts } from './agent-chat-context';
import { useClockTick } from './hooks/use-clock-tick';

/**
 * The composer's first row while an idle Chat's context needs attention: the prompt cache expired, so the next reply
 * re-reads the whole conversation (`--muted`: a cost fact, not a fault), or the context is high enough to compact first
 * (`--danger`, with a Compact button when the provider reports a compact command). It takes the activity bar's place
 * and shape, so it is hidden while a turn runs, when neither notice is actionable. Expiry is judged on a minute clock,
 * which only runs while a Chat with usage shows the composer. An expired cache also offers to continue in a new Chat,
 * which reads the old transcript through a cheap subagent instead of rewriting it.
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
    const alerts = agentChatContextAlerts(usage, useClockTick('minute'));
    if (!alerts.cache && !alerts.pressure) return null;
    const canCompact = alerts.pressure !== undefined && onCompact !== undefined;
    return (
        <div
            className="flex h-8 min-w-0 items-center gap-3 border-0 border-b border-solid border-border px-3 text-[12px]"
            role="status"
        >
            {alerts.cache && (
                <span className="flex min-w-0 items-center gap-2 text-muted">
                    <TimerOff aria-hidden className="size-3.5 shrink-0" />
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
            {(alerts.cache !== undefined || canCompact) && (
                <span className="-mr-1.5 ml-auto flex shrink-0 items-center gap-1">
                    {alerts.cache && (
                        <Tooltip content="Open a new Chat that reads this conversation's transcript and continues the work. Your draft goes with it.">
                            <button
                                aria-disabled={isContinuing || undefined}
                                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-(--motion-overlay-enter) ease-(--motion-ease-enter) not-aria-disabled:hover:bg-elevated not-aria-disabled:hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                                type="button"
                                onClick={onContinueInNewChat}
                            >
                                <MessageSquarePlus aria-hidden className="size-3.5" />
                                Continue in new Chat
                            </button>
                        </Tooltip>
                    )}
                    {canCompact && (
                        <Button
                            className="min-h-6 shrink-0 px-1.5 text-[12px]"
                            size="sm"
                            type="button"
                            variant="secondary"
                            onClick={onCompact}
                        >
                            Compact
                        </Button>
                    )}
                </span>
            )}
        </div>
    );
}
