import { Fragment } from 'react';

import type { AgentChatContextUsage } from '@caxri/protocol';
import { agentChatContextPercent, formatTokens } from '@caxri/protocol';

import { AnimatedNumber } from '../../../components/animated-number';
import { Button } from '../../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { contextCategoryLabel } from './category-labels';
import { inRequestOrder, segmentShade } from './composition';

/**
 * The ring the meter draws, as in the Codex app's composer: a faint full track and an arc of the share used over it.
 */
const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const TONE_CLASS_NAMES: Record<AgentChatContextUsage['tone'], string> = {
    normal: 'text-muted',
    warning: 'text-warning',
};

/**
 * The meter's card, laid out like Claude Code's `/context`: the headline count, a bar of the window with what fills it,
 * and a legend. Without a breakdown the bar is one segment in the meter's tone.
 */
function ContextCard({
    onCompact,
    onShowDetails,
    percent,
    usage,
}: {
    onCompact: (() => void) | undefined;
    onShowDetails: (() => void) | undefined;
    percent: number;
    usage: AgentChatContextUsage;
}) {
    const { t } = useTranslation();
    const rows = inRequestOrder(usage.breakdown);
    return (
        <span className="flex flex-col gap-2 text-[12px]">
            <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{t('agentChat.context.title')}</span>
                <span className="tabular-nums">
                    {formatTokens(usage.totalTokens)}
                    <span className="text-muted"> / {formatTokens(usage.limit)}</span>
                    <span className={cn('ml-1.5', TONE_CLASS_NAMES[usage.tone])}>{percent}%</span>
                </span>
            </span>
            <span aria-hidden className="flex h-1.5 overflow-hidden rounded bg-chart/10">
                {rows.length > 0 ? (
                    rows.map((row, index) => (
                        <span
                            className={cn('h-full', segmentShade(row, index))}
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
                            <span
                                aria-hidden
                                className={cn('size-2 rounded-sm', segmentShade(row, index))}
                            />
                            <span className="truncate text-muted">
                                {contextCategoryLabel(t, row.label)}
                            </span>
                            <span className="text-right tabular-nums">
                                {formatTokens(row.tokens)}
                            </span>
                        </Fragment>
                    ))}
                </span>
            )}
            {usage.modelWindow ? (
                <span className="text-[11px] leading-4 text-muted">
                    {t('agentChat.context.autoCompacts', {
                        window: formatTokens(usage.limit),
                        modelWindow: formatTokens(usage.modelWindow),
                    })}
                </span>
            ) : (
                usage.compactAt && (
                    <span className="text-[11px] leading-4 text-muted">
                        {t('agentChat.contextPage.window.autoCompact', {
                            tokens: formatTokens(usage.compactAt),
                        })}
                    </span>
                )
            )}
            {(onShowDetails !== undefined || onCompact !== undefined) && (
                <span className="flex justify-end gap-1.5">
                    {onShowDetails && (
                        <Button
                            className="min-h-6 px-2 text-[12px]"
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={onShowDetails}
                        >
                            {t('agentChat.context.details')}
                        </Button>
                    )}
                    {onCompact && (
                        <Button
                            className="min-h-6 px-2 text-[12px]"
                            size="sm"
                            type="button"
                            variant="secondary"
                            onClick={onCompact}
                        >
                            {t('agentChat.context.compact')}
                        </Button>
                    )}
                </span>
            )}
        </span>
    );
}

/**
 * How much of the context window the conversation uses, as a small filling ring in the composer's bottom row. It stays
 * a quiet neutral glyph with no number until the share reaches where the composer suggests compacting; from there it
 * turns `--warning` and shows the percentage, whose digits roll as a response moves it. Both measure against the window
 * the provider compacts at. Its card gives the token counts, what fills the window when the provider reports it, a
 * Details button opening the Chat's Context tab when the provider can describe its context, and a Compact button when
 * the provider has a compact command. The card opens on click only, so passing the pointer over the composer's bottom
 * row never throws a card over the draft; Enter or Space on the ring (a Tab stop) opens it with focus inside, and
 * Escape hands focus back. The ring is a `meter`, so a screen reader hears the share as a value with the counts as its
 * text.
 */
export function AgentChatContextMeter({
    onCompact,
    onShowDetails,
    usage,
}: {
    /**
     * Runs the provider's compact command; omitted when the provider reports none.
     */
    onCompact?: () => void;
    /**
     * Opens the Chat's Context tab; omitted for a provider that cannot report its context composition.
     */
    onShowDetails?: () => void;
    usage: AgentChatContextUsage;
}) {
    const { t } = useTranslation();
    const percent = agentChatContextPercent(usage.totalTokens, usage.limit);
    const description = t('agentChat.context.meterLabel', {
        percent,
        tokens: formatTokens(usage.totalTokens),
        window: formatTokens(usage.limit),
    });
    return (
        <Popover>
            <PopoverTrigger
                nativeButton={false}
                render={
                    <span
                        aria-label={description}
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={percent}
                        aria-valuetext={description}
                        className={cn(
                            'flex h-7 shrink-0 items-center gap-1 rounded-md px-1 text-[12px] leading-4 tabular-nums focus-visible:outline focus-visible:outline-accent',
                            TONE_CLASS_NAMES[usage.tone],
                        )}
                        // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- the Popover trigger draws an SVG ring; a native <meter> cannot host it.
                        role="meter"
                        tabIndex={0}
                    />
                }
            >
                <svg aria-hidden className="size-3.5 -rotate-90" viewBox="0 0 14 14">
                    <circle
                        className="stroke-current opacity-30"
                        cx="7"
                        cy="7"
                        fill="none"
                        r={RING_RADIUS}
                        strokeWidth="2"
                    />
                    {usage.used > 0 && (
                        <circle
                            className="stroke-current transition-[stroke-dashoffset] duration-(--motion-expand) ease-(--motion-ease-emphasized)"
                            cx="7"
                            cy="7"
                            fill="none"
                            r={RING_RADIUS}
                            strokeDasharray={RING_CIRCUMFERENCE}
                            strokeDashoffset={RING_CIRCUMFERENCE * (1 - usage.used)}
                            strokeLinecap="round"
                            strokeWidth="2"
                        />
                    )}
                </svg>
                {usage.tone === 'warning' && <AnimatedNumber suffix="%" value={percent} />}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 overflow-visible p-2.5" side="top">
                <ContextCard
                    onCompact={onCompact}
                    onShowDetails={onShowDetails}
                    percent={percent}
                    usage={usage}
                />
            </PopoverContent>
        </Popover>
    );
}
