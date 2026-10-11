import { Fragment } from 'react';

import { formatTokens } from '@caxri/protocol';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import type { AgentChatContextUsage } from './agent-chat-context';

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const TONE_CLASS_NAMES: Record<AgentChatContextUsage['tone'], string> = {
    normal: 'text-muted',
    warning: 'text-warning',
    danger: 'text-danger',
};

/**
 * Shades for the breakdown, one per row in order: the foreground at falling strengths, so the bar reads in any theme
 * without inventing chart colors, and each row's swatch matches its segment.
 */
const SEGMENT_SHADES = [
    'bg-foreground',
    'bg-foreground/70',
    'bg-foreground/50',
    'bg-foreground/35',
    'bg-foreground/25',
    'bg-foreground/15',
];

function shade(index: number): string {
    return SEGMENT_SHADES[Math.min(index, SEGMENT_SHADES.length - 1)];
}

/**
 * The meter's hover card, laid out like Claude Code's `/context`: the headline count, a bar of the window with what
 * fills it, and a legend. Without a breakdown the bar is one segment in the meter's tone.
 */
function ContextCard({ usage, percent }: { usage: AgentChatContextUsage; percent: number }) {
    const rows = usage.breakdown;
    return (
        <span className="flex w-60 flex-col gap-2 py-0.5">
            <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium">Context</span>
                <span className="tabular-nums">
                    {formatTokens(usage.totalTokens)}
                    <span className="text-muted"> / {formatTokens(usage.window)}</span>
                    <span className={cn('ml-1.5', TONE_CLASS_NAMES[usage.tone])}>{percent}%</span>
                </span>
            </span>
            <span aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-foreground/10">
                {rows.length > 0 ? (
                    rows.map((row, index) => (
                        <span
                            className={cn('h-full', shade(index))}
                            key={row.label}
                            style={{ width: `${(row.tokens / usage.window) * 100}%` }}
                        />
                    ))
                ) : (
                    <span
                        className={cn('h-full bg-current', TONE_CLASS_NAMES[usage.tone])}
                        style={{ width: `${usage.used * 100}%` }}
                    />
                )}
            </span>
            {rows.length > 0 && (
                <span className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
                    {rows.map((row, index) => (
                        <Fragment key={row.label}>
                            <span aria-hidden className={cn('size-2 rounded-sm', shade(index))} />
                            <span className="truncate text-muted">{row.label}</span>
                            <span className="text-right tabular-nums">
                                {formatTokens(row.tokens)}
                            </span>
                        </Fragment>
                    ))}
                </span>
            )}
            {usage.modelWindow && (
                <span className="text-[11px] leading-4 text-muted">
                    Auto-compacts at {formatTokens(usage.window)} of the{' '}
                    {formatTokens(usage.modelWindow)} window
                </span>
            )}
        </span>
    );
}

/**
 * How much of the context window the conversation uses, as a filling ring with the percentage beside it, the way the
 * Codex app shows it. Both measure against the window the provider compacts at, so the ring turns `--danger` exactly
 * when the composer suggests compacting. The hover card gives the token counts and, when the provider reports it, what
 * fills the window. The ring is a Tab stop so a keyboard user can raise that card too, and its accessible name carries
 * the counts for a screen reader.
 */
export function AgentChatContextMeter({ usage }: { usage: AgentChatContextUsage }) {
    const percent = Math.round(usage.used * 100);
    const tokens = `${formatTokens(usage.totalTokens)} / ${formatTokens(usage.window)} tokens`;
    return (
        <Tooltip content={<ContextCard percent={percent} usage={usage} />}>
            <span
                aria-label={`${percent}% of context used, ${tokens}`}
                className={cn(
                    'flex h-7 shrink-0 items-center gap-1 rounded-md px-1 text-[12px] leading-4 tabular-nums focus-visible:outline focus-visible:outline-accent',
                    TONE_CLASS_NAMES[usage.tone],
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
