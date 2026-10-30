import type { KeyboardEvent, PointerEvent } from 'react';
import { useState } from 'react';

import { formatTokens } from '@caxri/protocol';
import { clamp } from 'es-toolkit';

import { ReportCard } from '../../../../components/report-card';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { agentChatMessageFullTime } from '../../transcript/agent-chat-time';
import type { ContextTurnAnalysis, ContextTurnPoint } from './turn-analysis';

/**
 * The window after every request as a stacked column: the starting context, then what the conversation added by source.
 * Shades are steps of the one `--chart` role, like the window bar.
 */
const SHADES = {
    base: 'bg-muted/35',
    user: 'bg-chart/30',
    modelOutput: 'bg-chart/65',
    toolResults: 'bg-chart',
} as const;

type Part = keyof typeof SHADES;

/**
 * Stack order from the bottom: what stays put first, the freshest kind of growth last.
 */
const PARTS: readonly Part[] = ['base', 'user', 'modelOutput', 'toolResults'];

/**
 * Tools named in the selected turn's readout; the Server already keeps only the heaviest.
 */
const TOOLS_SHOWN = 6;

/**
 * How the window filled up request by request: the size after each request split into the starting context and what
 * each source added since, the autocompact line, compaction restarts, and the single largest growth. Pointing at a
 * column or pressing the arrow keys on the chart reads that request out above it, with the heaviest tool results by
 * name. The split is an estimate (see the note under the chart).
 */
export function ContextTurnsCard({
    analysis,
    autoCompactThreshold,
    isHistoryTruncated,
}: {
    analysis: ContextTurnAnalysis;
    autoCompactThreshold: number | undefined;
    isHistoryTruncated: boolean;
}) {
    const { t } = useTranslation();
    const { points } = analysis;
    // Only a report from before this field existed, or a fresh Chat, has no growth to show.
    if (points.length < 2) return null;
    return (
        <ReportCard
            title={t('agentChat.contextPage.turns.title')}
            caption={t('agentChat.contextPage.turns.caption', { count: points.length })}
        >
            <TurnChart
                analysis={analysis}
                autoCompactThreshold={autoCompactThreshold}
                isHistoryTruncated={isHistoryTruncated}
            />
        </ReportCard>
    );
}

function TurnChart({
    analysis,
    autoCompactThreshold,
    isHistoryTruncated,
}: {
    analysis: ContextTurnAnalysis;
    autoCompactThreshold: number | undefined;
    isHistoryTruncated: boolean;
}) {
    const { t } = useTranslation();
    const { points, largestGrowthIndex } = analysis;
    const [focusIndex, setFocusIndex] = useState<number>();
    const max = Math.max(1, autoCompactThreshold ?? 0, ...points.map((point) => point.prompt));
    // Clamped because a refresh can shorten the history while a column is still selected.
    const index = clamp(focusIndex ?? points.length - 1, 0, points.length - 1);
    const point = points[index];
    const columnWidth = 100 / points.length;
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const column = Math.floor(((event.clientX - box.left) / box.width) * points.length);
        setFocusIndex(clamp(column, 0, points.length - 1));
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const target = {
            ArrowLeft: index - 1,
            ArrowRight: index + 1,
            Home: 0,
            End: points.length - 1,
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        setFocusIndex(clamp(target, 0, points.length - 1));
    };
    return (
        <div>
            <TurnReadout
                isLargest={index === largestGrowthIndex}
                point={point}
                position={index + 1}
            />
            <div className="flex gap-2">
                <div className="flex h-28 flex-col justify-between text-right text-[10px] text-muted tabular-nums">
                    <span>{formatTokens(max)}</span>
                    <span>0</span>
                </div>
                <div
                    aria-label={t('agentChat.contextPage.turns.chartLabel')}
                    className="relative h-28 min-w-0 flex-1 cursor-crosshair rounded-sm border-b border-border focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                    role="group"
                    tabIndex={0}
                    onBlur={() => setFocusIndex(undefined)}
                    onKeyDown={onKeyDown}
                    onPointerLeave={() => setFocusIndex(undefined)}
                    onPointerMove={onPointerMove}
                >
                    <span
                        aria-hidden
                        className="absolute inset-y-0 bg-foreground/10"
                        style={{ left: `${index * columnWidth}%`, width: `${columnWidth}%` }}
                    />
                    <div
                        aria-hidden
                        className={cn(
                            'absolute inset-0 flex items-end',
                            points.length <= 160 && 'gap-px',
                        )}
                    >
                        {points.map((item, position) => (
                            <TurnColumn
                                // Requests never reorder, so the position is their identity.
                                key={position}
                                isLargest={position === largestGrowthIndex}
                                max={max}
                                point={item}
                            />
                        ))}
                    </div>
                    {points.map(
                        (item, position) =>
                            item.afterCompaction && (
                                <span
                                    key={position}
                                    aria-hidden
                                    className="absolute inset-y-0 w-px bg-muted/70"
                                    style={{ left: `${(position + 0.5) * columnWidth}%` }}
                                />
                            ),
                    )}
                    {autoCompactThreshold !== undefined && (
                        <span
                            aria-hidden
                            className="absolute inset-x-0 border-t border-dashed border-warning/80"
                            style={{ bottom: `${(autoCompactThreshold / max) * 100}%` }}
                        />
                    )}
                </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pl-8 text-[10px] whitespace-nowrap text-muted">
                {PARTS.map((part) => (
                    <span key={part} className="inline-flex items-center gap-1">
                        <span
                            aria-hidden
                            className={cn('size-2 shrink-0 rounded-sm', SHADES[part])}
                        />
                        {partLabel(t, part)}
                    </span>
                ))}
                <span className="inline-flex items-center gap-1">
                    <span aria-hidden className="h-2 w-px shrink-0 bg-muted/70" />
                    {t('agentChat.contextPage.cache.legendCompaction')}
                </span>
                {autoCompactThreshold !== undefined && (
                    <span className="inline-flex items-center gap-1">
                        <span
                            aria-hidden
                            className="w-3 shrink-0 border-t border-dashed border-warning/80"
                        />
                        {t('agentChat.contextPage.turns.threshold')}
                    </span>
                )}
            </div>
            {isHistoryTruncated && (
                <p className="mt-2 mb-0 text-[11px] text-muted">
                    {t('agentChat.contextPage.cache.truncated')}
                </p>
            )}
            <p className="mt-2 mb-0 text-[11px] leading-[1.5] text-pretty text-muted">
                {t('agentChat.contextPage.turns.note')}
            </p>
        </div>
    );
}

function partLabel(t: ReturnType<typeof useTranslation>['t'], part: Part): string {
    return t(`agentChat.contextPage.turns.${part === 'base' ? 'start' : part}`);
}

function TurnColumn({
    point,
    max,
    isLargest,
}: {
    point: ContextTurnPoint;
    max: number;
    isLargest: boolean;
}) {
    return (
        <span
            className={cn(
                'relative flex min-w-0 flex-1 flex-col-reverse',
                isLargest && 'outline outline-1 outline-offset-1 outline-warning',
            )}
            style={{ height: `${(point.prompt / max) * 100}%` }}
        >
            {PARTS.map((part) => (
                <span key={part} className={SHADES[part]} style={{ flexGrow: point[part] }} />
            ))}
        </span>
    );
}

function TurnReadout({
    point,
    position,
    isLargest,
}: {
    point: ContextTurnPoint;
    position: number;
    isLargest: boolean;
}) {
    const { t } = useTranslation();
    const { turn } = point;
    return (
        <div
            aria-live="polite"
            className="mb-2 flex min-h-10 flex-col gap-1 text-[11px] text-muted tabular-nums"
        >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-foreground">
                    {t('agentChat.contextPage.turns.request', {
                        index: position,
                        time: agentChatMessageFullTime(point.at, t.locale),
                    })}
                </span>
                <span>
                    {t('agentChat.contextPage.turns.window', {
                        tokens: formatTokens(point.prompt),
                    })}
                </span>
                {point.afterCompaction ? (
                    <span>{t('agentChat.contextPage.turns.compacted')}</span>
                ) : turn ? (
                    <span className="text-foreground">
                        {t('agentChat.contextPage.turns.added', {
                            tokens: formatTokens(point.growth),
                        })}
                    </span>
                ) : (
                    <span>{t('agentChat.contextPage.turns.noGrowth')}</span>
                )}
                {isLargest && (
                    <span className="text-warning">{t('agentChat.contextPage.turns.largest')}</span>
                )}
            </div>
            {turn && !point.afterCompaction && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="sr-only">
                        {t('agentChat.contextPage.turns.summary', {
                            total: formatTokens(point.growth),
                            toolResults: formatTokens(turn.toolResults),
                            modelOutput: formatTokens(turn.modelOutput),
                            user: formatTokens(turn.user),
                        })}
                    </span>
                    <span aria-hidden>
                        {t('agentChat.contextPage.turns.toolResults')} +
                        {formatTokens(turn.toolResults)}
                        {turn.tools.length > 0 &&
                            `: ${turn.tools
                                .slice(0, TOOLS_SHOWN)
                                .map((tool) => `${tool.name} ${formatTokens(tool.tokens)}`)
                                .join(', ')}`}
                    </span>
                    <span aria-hidden>
                        {t('agentChat.contextPage.turns.modelOutput')} +
                        {formatTokens(turn.modelOutput)}
                    </span>
                    <span aria-hidden>
                        {t('agentChat.contextPage.turns.user')} +{formatTokens(turn.user)}
                    </span>
                </div>
            )}
        </div>
    );
}
