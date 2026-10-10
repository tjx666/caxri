import { formatTokens } from '@caxri/protocol';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import type { AgentChatContextUsage } from './agent-chat-presentation';

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Past these shares the Agent is close to compacting or running out, so the ring changes color before it fills.
 */
const WARNING_SHARE = 0.8;
const DANGER_SHARE = 0.95;

/**
 * How much of the context window the conversation uses, as a filling ring with the percentage beside it, the way the
 * Codex app shows it. The tooltip gives the token counts behind the percentage. The ring is a Tab stop so a keyboard
 * user can raise that tooltip too, and its accessible name carries the counts for a screen reader.
 */
export function AgentChatContextMeter({ usage }: { usage: AgentChatContextUsage }) {
    const percent = Math.round(usage.used * 100);
    const tokens = `${formatTokens(usage.totalTokens)} / ${formatTokens(usage.contextWindow)} tokens`;
    const tone =
        usage.used >= DANGER_SHARE
            ? 'text-danger'
            : usage.used >= WARNING_SHARE
              ? 'text-warning'
              : 'text-muted';
    return (
        <Tooltip
            content={
                <span className="flex flex-col">
                    <span>{percent}% of context used</span>
                    <span className="text-muted">{tokens}</span>
                </span>
            }
        >
            <span
                aria-label={`${percent}% of context used, ${tokens}`}
                className={cn(
                    'flex h-7 shrink-0 items-center gap-1 rounded-md px-1 text-[12px] leading-4 tabular-nums focus-visible:outline focus-visible:outline-accent',
                    tone,
                )}
                role="img"
                tabIndex={0}
            >
                <svg aria-hidden className="size-3.5 -rotate-90" viewBox="0 0 14 14">
                    <circle
                        className="stroke-current opacity-25"
                        cx="7"
                        cy="7"
                        fill="none"
                        r={RADIUS}
                        strokeWidth="1.75"
                    />
                    {usage.used > 0 && (
                        <circle
                            className="stroke-current transition-[stroke-dashoffset] duration-(--motion-expand) ease-(--motion-ease-emphasized)"
                            cx="7"
                            cy="7"
                            fill="none"
                            r={RADIUS}
                            strokeDasharray={CIRCUMFERENCE}
                            strokeDashoffset={CIRCUMFERENCE * (1 - usage.used)}
                            strokeLinecap="round"
                            strokeWidth="1.75"
                        />
                    )}
                </svg>
                {percent}%
            </span>
        </Tooltip>
    );
}
