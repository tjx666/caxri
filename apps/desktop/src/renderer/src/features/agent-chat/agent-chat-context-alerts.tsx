import type { AgentChatUsage } from '@caxri/protocol';
import { Gauge, TimerOff } from 'lucide-react';

import { agentChatContextAlerts } from './agent-chat-context';
import { useClockTick } from './hooks/use-clock-tick';

/**
 * The composer's first row while an idle Chat's context needs attention: the prompt cache expired, so the next message
 * pays to write the whole context again (`--warning`), or the context is high enough to compact first (`--danger`). It
 * takes the activity bar's place and shape, so it is hidden while a turn runs, when neither notice is actionable.
 * Expiry is judged on a minute clock, which only runs while a Chat with usage shows the composer.
 */
export function AgentChatContextAlerts({ usage }: { usage: AgentChatUsage }) {
    const alerts = agentChatContextAlerts(usage, useClockTick('minute'));
    if (!alerts.cache && !alerts.pressure) return null;
    return (
        <div
            className="flex h-8 min-w-0 items-center gap-3 border-0 border-b border-solid border-border px-3 text-[12px]"
            role="status"
        >
            {alerts.cache && (
                <span className="flex min-w-0 items-center gap-2 text-warning">
                    <TimerOff aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate" title={alerts.cache.detail}>
                        {alerts.cache.text}
                    </span>
                </span>
            )}
            {alerts.cache && alerts.pressure && (
                <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
            )}
            {alerts.pressure && (
                <span className="flex min-w-0 items-center gap-2 text-danger">
                    <Gauge aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate" title={alerts.pressure.detail}>
                        {alerts.pressure.text}
                    </span>
                </span>
            )}
        </div>
    );
}
