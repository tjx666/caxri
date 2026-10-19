import type { UsageLimit, UsageReport } from '@caxri/protocol';
import {
    formatLineCount,
    formatPercent,
    formatTokens,
    formatUsd,
    remainingLimitPercent,
} from '@caxri/protocol';

import { ReportCard, StatTile } from '../../components/report-card';
import { Progress } from '../../components/ui/progress';
import { Tooltip } from '../../components/ui/tooltip';
import { useChartKeyboardCursor } from '../../hooks/use-chart-keyboard-cursor';
import { useRelativeTime } from '../../hooks/use-relative-time';
import { useTranslation } from '../../i18n';
import { CHART_CURSOR_CLASS } from '../../lib/chart-cursor';
import { formatCount } from '../../lib/locale-format';
import { localizedDuration, localizedLimitWindowName } from '../../lib/usage-format';
import { cn } from '../../lib/utilities';
import { ProviderLabel } from './provider-label';
import { UsageActivityCard } from './usage-activity-card';
import { UsageCost } from './usage-cost';
import { UsageDetailCards } from './usage-detail-cards';
import {
    agentTimeDetail,
    burnRateCaption,
    computeStreaks,
    costTileDetail,
    countLabel,
    formatHour,
    formatMetric,
    hasUnpricedProviderModel,
    isUsageUnpriced,
    limitWindowState,
    peakHour,
    usageCostDisplay,
    usageHourTooltip,
    usageSessionCount,
} from './usage-metrics';
import { buildUsageInsights, usageCoverageNotes } from './usage-notes';
import {
    limitBarTone,
    pullRequestTileDetail,
    usageShare,
    usageShareBasis,
    usageShareCaption,
} from './usage-presentation';
import { UsageShareBar } from './usage-share-bar';

function KpiTiles({ report }: { report: UsageReport }) {
    const { t } = useTranslation();
    const { totals } = report;
    const streaks = computeStreaks(report.activity, report.today);
    const cacheRate = totals.tokens.total > 0 ? totals.tokens.cacheRead / totals.tokens.total : 0;
    const isUnpriced = isUsageUnpriced(report);
    return (
        // Columns follow the pane (container queries), not the window: the Usage tab often sits in a narrow split while
        // the window is wide, so viewport breakpoints kept six columns in a 600px pane and clipped every figure. The six
        // tiles step through 2, 3, and 6 columns, divisors of six, so no width leaves one tile alone on a second row.
        <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2 @xl:grid-cols-3 @5xl:grid-cols-6">
            <StatTile
                label={t('usage.kpi.cost')}
                value={isUnpriced ? t('usage.cost.noPrice') : formatUsd(totals.costUsd)}
                detail={costTileDetail(t, report, isUnpriced)}
            />
            <StatTile
                label={t('usage.tokens')}
                value={formatTokens(totals.tokens.total)}
                detail={t('usage.kpi.cacheReads', { percent: formatPercent(cacheRate) })}
            />
            <StatTile
                label={t('usage.agentTime.title')}
                value={localizedDuration(totals.activeMs, t)}
                detail={agentTimeDetail(t, totals)}
            />
            <StatTile
                label={t('usage.kpi.sessions')}
                value={t('usage.kpi.sessionsCreated', {
                    count: formatCount(totals.sessionsCreated),
                })}
                detail={t('usage.kpi.sessionsArchived', {
                    count: formatCount(totals.sessionsArchived),
                })}
            />
            <StatTile
                label={t('usage.kpi.pullRequests')}
                value={t('usage.kpi.pullRequestsMerged', {
                    count: formatCount(totals.pullRequestsMerged),
                })}
                detail={
                    // A comma, not ` · `: when the tile is narrow the second fact wraps, and a comma may end a line
                    // where a dangling middle dot read as a broken separator.
                    pullRequestTileDetail(t, totals, formatLineCount).map((fact, index, facts) => (
                        <span key={fact}>
                            <span className="whitespace-nowrap">
                                {fact}
                                {index < facts.length - 1 && ','}
                            </span>
                            {index < facts.length - 1 && ' '}
                        </span>
                    ))
                }
            />
            {/* Read from the trailing-year activity, like the Activity card, so the range selector does not move it. */}
            <StatTile
                label={t('usage.kpi.streak')}
                value={countLabel(t, streaks.current, 'day')}
                detail={t('usage.kpi.longestStreak', {
                    days: countLabel(t, streaks.longest, 'day'),
                })}
            />
        </div>
    );
}

function InsightsCard({ report }: { report: UsageReport }) {
    const { t } = useTranslation();
    const insights = buildUsageInsights(t, report);
    return (
        <ReportCard title={t('usage.insights.title')}>
            {insights.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('usage.insights.empty')}</p>
            ) : (
                <ul className="m-0 grid list-disc gap-1 pl-4 text-[12px] leading-[1.5]">
                    {insights.map((insight) => (
                        <li key={insight}>{insight}</li>
                    ))}
                </ul>
            )}
        </ReportCard>
    );
}

function CoverageNote({ report }: { report: UsageReport }) {
    const { t } = useTranslation();
    const notes = usageCoverageNotes(t, report);
    return (
        <div className="grid gap-1 text-[11px] leading-[1.5] text-muted">
            {notes.map((note) => (
                <p key={note} className="m-0">
                    {note}
                </p>
            ))}
        </div>
    );
}

function BurnCard({ report }: { report: UsageReport }) {
    const { today, last7Days, last30Days } = report.windows;
    const { t } = useTranslation();
    const isUnpriced = isUsageUnpriced(report);
    const rows = [
        { label: t('usage.burn.today'), window: today, perDay: today.costUsd },
        { label: t('usage.rangeLabel.7d'), window: last7Days, perDay: last7Days.costUsd / 7 },
        {
            label: t('usage.rangeLabel.30d'),
            window: last30Days,
            perDay: last30Days.costUsd / 30,
        },
    ];
    return (
        <ReportCard
            title={t('usage.burn.title')}
            caption={burnRateCaption(t, last30Days.costUsd, isUnpriced)}
        >
            <div className="grid gap-2">
                {rows.map(({ label, window, perDay }) => (
                    <div
                        key={label}
                        className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3"
                    >
                        <span className="text-[12px] text-muted">{label}</span>
                        <span className="text-[11px] text-muted tabular-nums">
                            {formatMetric(t, window.tokens, 'tokens')}
                            {!isUnpriced &&
                                ` · ${t('usage.burn.perDay', { cost: formatUsd(perDay) })}`}
                        </span>
                        <UsageCost
                            className="min-w-16 text-right text-[13px] font-semibold"
                            display={
                                isUnpriced
                                    ? { kind: 'unpriced' }
                                    : { kind: 'priced', label: formatUsd(window.costUsd) }
                            }
                        />
                    </div>
                ))}
            </div>
        </ReportCard>
    );
}

function LimitWindowRow({
    generatedAt,
    observedAgo,
    window,
}: {
    generatedAt: number;
    observedAgo: string | undefined;
    window: UsageLimit['windows'][number];
}) {
    const { t } = useTranslation();
    const name = localizedLimitWindowName(window.windowMinutes, t);
    const state = limitWindowState(window, generatedAt, t);
    const isReset = state.kind === 'reset';
    return (
        <div className="grid gap-1">
            <div className="flex justify-between gap-2 text-[11px]">
                <span className="text-muted">{name}</span>
                {isReset ? (
                    <span className="text-muted">
                        {observedAgo
                            ? t('usage.limits.resetSince', { time: observedAgo })
                            : t('usage.limits.resetSinceUnknown')}
                    </span>
                ) : (
                    <span className="tabular-nums">
                        {t('usage.limits.left', {
                            percent: remainingLimitPercent(window.usedPercent),
                        })}
                        {state.resetLabel && (
                            <span className="text-muted"> · {state.resetLabel}</span>
                        )}
                    </span>
                )}
            </div>
            {/* A reset window's last percentage belongs to the window that ended, so its bar is dimmed, not dropped. */}
            <Progress
                variant={limitBarTone(window.usedPercent) === 'warning' ? 'meterWarning' : 'meter'}
                aria-label={t(isReset ? 'usage.limits.resetLabel' : 'usage.limits.leftLabel', {
                    name,
                })}
                className={cn(isReset && 'opacity-40')}
                value={remainingLimitPercent(window.usedPercent)}
            />
        </div>
    );
}

function ProviderLimits({ generatedAt, limit }: { generatedAt: number; limit: UsageLimit }) {
    const { t } = useTranslation();
    const observedAgo = useRelativeTime(limit.observedAt);
    return (
        <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2 text-[12px]">
                <ProviderLabel provider={limit.provider} />
                <span className="text-[11px] text-muted">
                    {limit.planType && <span className="capitalize">{limit.planType}</span>}
                    {limit.planType && observedAgo && ' · '}
                    {observedAgo && t('usage.limits.asOf', { time: observedAgo })}
                </span>
            </div>
            {limit.windows.map((window) => (
                <LimitWindowRow
                    key={window.windowMinutes}
                    generatedAt={generatedAt}
                    observedAgo={observedAgo}
                    window={window}
                />
            ))}
        </div>
    );
}

function LimitsCard({ report }: { report: UsageReport }) {
    const { t } = useTranslation();
    if (report.limits.length === 0) return null;
    return (
        <ReportCard title={t('usage.limits.title')} caption={t('usage.limits.caption')}>
            <div className="grid gap-3">
                {report.limits.map((limit) => (
                    <ProviderLimits
                        key={limit.provider}
                        generatedAt={report.generatedAt}
                        limit={limit}
                    />
                ))}
            </div>
        </ReportCard>
    );
}

function AgentsCard({ report }: { report: UsageReport }) {
    const basis = usageShareBasis(report);
    const total = { costUsd: report.totals.costUsd, tokens: report.totals.tokens.total };
    const { t } = useTranslation();
    return (
        <ReportCard title={t('usage.agents.title')} caption={usageShareCaption(t, basis)}>
            {report.providers.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('usage.agents.empty')}</p>
            ) : (
                <div className="grid gap-3">
                    {report.providers.map((row) => (
                        <div key={row.provider} className="grid gap-1">
                            <div className="flex items-center justify-between gap-3 text-[12px]">
                                <ProviderLabel provider={row.provider} />
                                <UsageCost
                                    className="font-semibold"
                                    display={usageCostDisplay({
                                        costUsd: row.costUsd,
                                        hasTokens: row.tokens.total > 0,
                                        hasUnpriced: hasUnpricedProviderModel(
                                            report.models,
                                            row.provider,
                                        ),
                                    })}
                                />
                            </div>
                            <UsageShareBar
                                basis={basis}
                                share={usageShare(
                                    { costUsd: row.costUsd, tokens: row.tokens.total },
                                    total,
                                    basis,
                                )}
                            />
                            <div className="flex justify-between gap-3 text-[11px] text-muted tabular-nums">
                                <span>
                                    {t('usage.agents.tokensCached', {
                                        percent: formatPercent(
                                            row.tokens.total > 0
                                                ? row.tokens.cacheRead / row.tokens.total
                                                : 0,
                                        ),
                                        tokens: formatTokens(row.tokens.total),
                                    })}
                                </span>
                                <span>
                                    {usageSessionCount(t, row.sessions, report.scope === 'all')} ·{' '}
                                    {localizedDuration(row.activeMs, t)}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </ReportCard>
    );
}

/**
 * Tab reaches the chart's summary; the arrow keys then step through the hours (`lib/chart-cursor.ts`), ringing the bar
 * and showing its Tooltip text in the caption, announced through a polite live region.
 */
function HourOfDayCard({ report }: { report: UsageReport }) {
    const peak = Math.max(0, ...report.hourOfDay);
    const busiest = peakHour(report.hourOfDay);
    const { t } = useTranslation();
    const keyboard = useChartKeyboardCursor(
        { kind: 'linear', count: report.hourOfDay.length },
        'hours',
    );
    const cursor = keyboard.cursor;
    const cursorText =
        cursor === undefined ? undefined : usageHourTooltip(t, cursor, report.hourOfDay[cursor]);
    return (
        <ReportCard
            title={t('usage.hours.title')}
            caption={
                cursorText ??
                (busiest === undefined
                    ? undefined
                    : t('usage.hours.peak', { hour: formatHour(busiest) }))
            }
        >
            <div
                aria-label={
                    busiest === undefined
                        ? t('usage.noUsage')
                        : t('usage.hours.peakLabel', { hour: formatHour(busiest) })
                }
                className="grid h-20 grid-cols-24 items-end gap-0.5 rounded-sm focus-visible:outline focus-visible:outline-accent"
                role="img"
                tabIndex={0}
                onBlur={keyboard.onBlur}
                onKeyDown={keyboard.onKeyDown}
            >
                {/* The full-height column is the trigger, so a quiet hour is as easy to hover as the peak. */}
                {report.hourOfDay.map((tokens, hour) => (
                    <Tooltip key={hour} content={usageHourTooltip(t, hour, tokens)}>
                        <div
                            className={cn(
                                'flex h-full items-end rounded-sm',
                                hour === cursor && CHART_CURSOR_CLASS,
                            )}
                        >
                            <div
                                className={cn(
                                    'w-full rounded-sm',
                                    tokens > 0 ? 'bg-chart/60' : 'bg-elevated',
                                )}
                                style={{
                                    height:
                                        peak > 0 && tokens > 0
                                            ? `${Math.max(6, (tokens / peak) * 100)}%`
                                            : '6%',
                                }}
                            />
                        </div>
                    </Tooltip>
                ))}
            </div>
            <span className="sr-only" aria-live="polite">
                {cursorText}
            </span>
            <div aria-hidden="true" className="mt-1 grid grid-cols-4 text-[11px] text-muted">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
            </div>
        </ReportCard>
    );
}

/**
 * The Usage page body for one report: headline figures, the activity chart, spend breakdowns, and coverage notes.
 */
export function UsageSections({ report }: { report: UsageReport }) {
    const hasLimits = report.limits.length > 0;
    return (
        // A size container, so the two-column rows follow the pane's width rather than the window's.
        <div className="@container mx-auto grid max-w-6xl gap-3 p-4">
            <KpiTiles report={report} />
            <UsageActivityCard activity={report.activity} today={report.today} />
            <div className="grid gap-3 @3xl:grid-cols-2">
                <BurnCard report={report} />
                <HourOfDayCard report={report} />
            </div>
            <div className="grid gap-3 @3xl:grid-cols-2">
                <AgentsCard report={report} />
                {hasLimits ? <LimitsCard report={report} /> : <InsightsCard report={report} />}
            </div>
            {hasLimits && <InsightsCard report={report} />}
            <UsageDetailCards report={report} />
            <CoverageNote report={report} />
        </div>
    );
}
