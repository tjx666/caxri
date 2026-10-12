import type { UsageLimit, UsageReport } from '@caxri/protocol';
import {
    formatDuration,
    formatLimitWindowName,
    formatLineCount,
    formatPercent,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import { ReportCard, StatTile } from '../../components/report-card';
import { Progress } from '../../components/ui/progress';
import { Tooltip } from '../../components/ui/tooltip';
import { useRelativeTime } from '../../hooks/use-relative-time';
import { cn } from '../../lib/utilities';
import { ProviderLabel } from './provider-label';
import { ShareBar } from './share-bar';
import { UsageActivityCard } from './usage-activity-card';
import { UsageCost } from './usage-cost';
import { UsageDetailCards } from './usage-detail-cards';
import {
    agentTimeDetail,
    buildUsageInsights,
    burnRateCaption,
    computeStreaks,
    costTileDetail,
    countLabel,
    formatHour,
    hasUnpricedProviderModel,
    isUsageUnpriced,
    limitWindowState,
    peakHour,
    usageCostDisplay,
    usageCoverageNotes,
    usageHourTooltip,
    usageSessionCount,
} from './usage-metrics';
import {
    limitBarTone,
    pullRequestTileDetail,
    usageShare,
    usageShareBasis,
} from './usage-presentation';

function KpiTiles({ report }: { report: UsageReport }) {
    const { totals } = report;
    const streaks = computeStreaks(report.activity, report.today);
    const cacheRate = totals.tokens.total > 0 ? totals.tokens.cacheRead / totals.tokens.total : 0;
    const isUnpriced = isUsageUnpriced(report);
    return (
        // Auto-fit against the pane, not the window: the Usage tab often sits in a narrow split while the window is wide,
        // so viewport breakpoints kept six columns in a 600px pane and clipped every figure.
        <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
            <StatTile
                label="Est. API cost"
                value={isUnpriced ? 'No price' : formatUsd(totals.costUsd)}
                detail={costTileDetail(report, isUnpriced)}
            />
            <StatTile
                label="Tokens"
                value={formatTokens(totals.tokens.total)}
                detail={`${formatPercent(cacheRate)} cache reads`}
            />
            <StatTile
                label="Agent time"
                value={formatDuration(totals.activeMs)}
                detail={agentTimeDetail(totals)}
            />
            <StatTile
                label="Sessions"
                value={`${totals.sessionsCreated.toLocaleString('en-US')} created`}
                detail={`${totals.sessionsArchived.toLocaleString('en-US')} archived`}
            />
            <StatTile
                label="Pull requests"
                value={`${totals.pullRequestsMerged.toLocaleString('en-US')} merged`}
                detail={
                    // A comma, not ` · `: when the tile is narrow the second fact wraps, and a comma may end a line
                    // where a dangling middle dot read as a broken separator.
                    pullRequestTileDetail(totals, formatLineCount).map((fact, index, facts) => (
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
                label="Streak (past year)"
                value={countLabel(streaks.current, 'day')}
                detail={`Longest ${countLabel(streaks.longest, 'day')}`}
            />
        </div>
    );
}

function InsightsCard({ report }: { report: UsageReport }) {
    const insights = buildUsageInsights(report);
    return (
        <ReportCard title="Highlights">
            {insights.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">
                    Highlights appear once Agents have used some tokens.
                </p>
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
    const notes = usageCoverageNotes(report);
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
    const isUnpriced = isUsageUnpriced(report);
    const rows = [
        { label: 'Today', window: today, perDay: today.costUsd },
        { label: 'Last 7 days', window: last7Days, perDay: last7Days.costUsd / 7 },
        { label: 'Last 30 days', window: last30Days, perDay: last30Days.costUsd / 30 },
    ];
    return (
        <ReportCard title="Burn rate" caption={burnRateCaption(last30Days.costUsd, isUnpriced)}>
            <div className="grid gap-2">
                {rows.map(({ label, window, perDay }) => (
                    <div
                        key={label}
                        className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3"
                    >
                        <span className="text-[12px] text-muted">{label}</span>
                        <span className="text-[11px] text-muted tabular-nums">
                            {formatTokens(window.tokens)} tokens
                            {!isUnpriced && ` · ${formatUsd(perDay)}/day`}
                        </span>
                        <UsageCost
                            className="min-w-16 text-right text-[13px] font-semibold"
                            display={
                                isUnpriced
                                    ? { kind: 'unpriced', label: 'No price' }
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
    const name = formatLimitWindowName(window.windowMinutes);
    const state = limitWindowState(window, generatedAt);
    const isReset = state.kind === 'reset';
    return (
        <div className="grid gap-1">
            <div className="flex justify-between gap-2 text-[11px]">
                <span className="text-muted">{name}</span>
                {isReset ? (
                    <span className="text-muted">
                        Window reset; usage not reported since {observedAgo ?? 'then'}
                    </span>
                ) : (
                    <span className="tabular-nums">
                        {Math.round(window.usedPercent)}% used
                        {state.resetLabel && (
                            <span className="text-muted"> · {state.resetLabel}</span>
                        )}
                    </span>
                )}
            </div>
            {/* A reset window's last percentage belongs to the window that ended, so its bar is dimmed, not dropped. */}
            <Progress
                variant={limitBarTone(window.usedPercent) === 'warning' ? 'meterWarning' : 'meter'}
                aria-label={
                    isReset ? `${name} limit, reset since last reported` : `${name} limit used`
                }
                className={cn(isReset && 'opacity-40')}
                value={window.usedPercent}
            />
        </div>
    );
}

function ProviderLimits({ generatedAt, limit }: { generatedAt: number; limit: UsageLimit }) {
    const observedAgo = useRelativeTime(limit.observedAt);
    return (
        <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2 text-[12px]">
                <ProviderLabel provider={limit.provider} />
                <span className="text-[11px] text-muted">
                    {limit.planType && <span className="capitalize">{limit.planType}</span>}
                    {limit.planType && observedAgo && ' · '}
                    {observedAgo && `as of ${observedAgo}`}
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
    if (report.limits.length === 0) return null;
    return (
        <ReportCard
            title="Plan limits"
            caption="Current windows, account-wide, as last reported by the Agent"
        >
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
    return (
        <ReportCard title="Agents">
            {report.providers.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No Agent usage in this range.</p>
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
                            <ShareBar
                                share={usageShare(
                                    { costUsd: row.costUsd, tokens: row.tokens.total },
                                    total,
                                    basis,
                                )}
                            />
                            <div className="flex justify-between gap-3 text-[11px] text-muted tabular-nums">
                                <span>
                                    {formatTokens(row.tokens.total)} tokens ·{' '}
                                    {formatPercent(
                                        row.tokens.total > 0
                                            ? row.tokens.cacheRead / row.tokens.total
                                            : 0,
                                    )}{' '}
                                    cached
                                </span>
                                <span>
                                    {usageSessionCount(row.sessions, report.scope === 'all')} ·{' '}
                                    {formatDuration(row.activeMs)}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </ReportCard>
    );
}

function HourOfDayCard({ report }: { report: UsageReport }) {
    const peak = Math.max(0, ...report.hourOfDay);
    const busiest = peakHour(report.hourOfDay);
    return (
        <ReportCard
            title="Time of day"
            caption={busiest === undefined ? undefined : `Peak at ${formatHour(busiest)}`}
        >
            <div
                aria-label={
                    busiest === undefined
                        ? 'No usage'
                        : `Most tokens are used around ${formatHour(busiest)}`
                }
                className="grid h-20 grid-cols-24 items-end gap-0.5"
                role="img"
            >
                {/* The full-height column is the trigger, so a quiet hour is as easy to hover as the peak. */}
                {report.hourOfDay.map((tokens, hour) => (
                    <Tooltip key={hour} content={usageHourTooltip(hour, tokens)}>
                        <div className="flex h-full items-end">
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
