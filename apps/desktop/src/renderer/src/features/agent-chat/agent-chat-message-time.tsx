import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import {
    agentChatDayLabel,
    agentChatMessageFullTime,
    agentChatMessageTime,
} from './agent-chat-time';
import { useClockTick } from './hooks/use-clock-tick';

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
