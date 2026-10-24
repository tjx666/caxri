import type { AgentChatTurnMetrics } from '@caxri/protocol';
import { CircleDollarSign } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { agentChatReplyMetrics } from '../activity/agent-chat-turn-metrics';
import { useClockTick } from '../hooks/use-clock-tick';
import {
    agentChatDayLabel,
    agentChatMessageFullTime,
    agentChatMessageTime,
} from '../transcript/agent-chat-time';

/**
 * When a message was sent, as a quiet clock time in its action row; the full date is one hover away and is the
 * element's accessible name.
 */
export function AgentChatMessageTime({ timestamp }: { timestamp: number }) {
    const fullTime = agentChatMessageFullTime(timestamp);
    return (
        <Tooltip content={fullTime}>
            {/* The full date as its name too: a screen reader hears it without the hover tooltip. */}
            <time
                aria-label={fullTime}
                className="px-1 text-[11px] leading-6 text-muted tabular-nums"
                dateTime={new Date(timestamp).toISOString()}
            >
                {agentChatMessageTime(timestamp)}
            </time>
        </Tooltip>
    );
}

/**
 * A finished turn's speed and cost after its reply's time, in the same quiet type (the cost behind a dollar glyph),
 * with the measured totals and the estimate caveat on hover. Renders nothing for a turn that recorded neither.
 */
export function AgentChatTurnMetricsLabel({ metrics }: { metrics?: AgentChatTurnMetrics }) {
    const { t } = useTranslation();
    const readout = agentChatReplyMetrics(metrics, t);
    if (!readout) return null;
    return (
        <Tooltip
            content={readout.details.map((line) => (
                <div key={line}>{line}</div>
            ))}
        >
            <span
                aria-label={readout.details.join('. ')}
                className="inline-flex items-center gap-2.5 px-1 text-[11px] leading-6 text-muted tabular-nums"
                data-agent-chat-turn-metrics=""
            >
                {readout.rate && <span>{readout.rate}</span>}
                {readout.cost && (
                    <span className="inline-flex items-center gap-1">
                        <CircleDollarSign aria-hidden="true" className="size-3.5 shrink-0" />
                        {readout.cost}
                    </span>
                )}
            </span>
        </Tooltip>
    );
}

/**
 * The centered day label above the first message of each day. It reads the minute clock so `Today` turns into
 * `Yesterday` at midnight without waiting for the conversation to change.
 */
export function AgentChatDayBreak({ timestamp }: { timestamp: number }) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    return (
        <p className="m-0 pt-2 text-center text-[11px] leading-4 text-muted tabular-nums">
            <time dateTime={new Date(timestamp).toISOString()}>
                {agentChatDayLabel(timestamp, now, t)}
            </time>
        </p>
    );
}
