import type { UsageReport } from '@caxri/protocol';
import {
    formatDuration,
    formatLimitReset,
    formatLimitWindowName,
    formatLineCount,
    formatPercent,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import { ReportCard, StatTile } from '../../components/report-card';
import { Progress } from '../../components/ui/progress';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { ProviderLabel } from './provider-label';
import { ShareBar } from './share-bar';
import { UsageActivityCard } from './usage-activity-card';
import { UsageDetailCards } from './usage-detail-cards';
import type { UsageMetric } from './usage-metrics';
import {
    agentTimeDetail,
    buildUsageInsights,
    burnRateCaption,
    computeStreaks,
    formatHour,
    peakHour,
    usageCoverageNotes,
    usageHourTooltip,
    usageSessionCount,
} from './usage-metrics';

function KpiTiles({ report }: { report: UsageReport }) {
    const { totals } = report;
    const streaks = computeStreaks(report.activity, report.today);
    const cacheRate = totals.tokens.total > 0 ? totals.tokens.cacheRead / totals.tokens.total : 0;
    return (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <StatTile
                label="Est. API cost"
                value={formatUsd(totals.costUsd)}
                detail={`${formatUsd(totals.cacheSavingsUsd)} cache savings`}
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
                value={`${totals.sessionsCreated} created`}
                detail={`${totals.sessionsArchived} archived`}
            />
            <StatTile
                label="Pull requests"
                value={`${totals.pullRequestsMerged} merged`}
                detail={
                    <>
                        <span className="whitespace-nowrap">{`+${formatLineCount(totals.linesAdded)} -${formatLineCount(totals.linesDeleted)} lines`}</span>
                        {' · '}
                        <span className="whitespace-nowrap">{`${totals.pullRequestsCreated} opened`}</span>
                    </>
                }
            />
            {/* Read from the trailing-year activity, like the Activity card, so the range selector does not move it. */}
            <StatTile
                label="Streak (past year)"
                value={`${streaks.current} ${streaks.current === 1 ? 'day' : 'days'}`}
                detail={`Longest ${streaks.longest} ${streaks.longest === 1 ? 'day' : 'days'}`}
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
    const rows = [
        { label: 'Today', window: today, perDay: today.costUsd },
        { label: 'Last 7 days', window: last7Days, perDay: last7Days.costUsd / 7 },
        { label: 'Last 30 days', window: last30Days, perDay: last30Days.costUsd / 30 },
    ];
    return (
        <ReportCard title="Burn rate" caption={burnRateCaption(last30Days.costUsd)}>
            <div className="grid gap-2">
                {rows.map(({ label, window, perDay }) => (
                    <div
                        key={label}
                        className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3"
                    >
                        <span className="text-[12px] text-muted">{label}</span>
                        <span className="text-[11px] text-muted tabular-nums">
                            {formatTokens(window.tokens)} · {formatUsd(perDay)}/day
                        </span>
                        <span className="min-w-16 text-right text-[13px] font-semibold tabular-nums">
                            {formatUsd(window.costUsd)}
                        </span>
                    </div>
                ))}
            </div>
        </ReportCard>
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
                    <div key={limit.provider} className="grid gap-2">
                        <div className="flex items-center justify-between gap-2 text-[12px]">
                            <ProviderLabel provider={limit.provider} />
                            {limit.planType && (
                                <span className="text-[11px] text-muted capitalize">
                                    {limit.planType}
                                </span>
                            )}
                        </div>
                        {limit.windows.map((window) => (
                            <div key={window.windowMinutes} className="grid gap-1">
                                <div className="flex justify-between gap-2 text-[11px]">
                                    <span className="text-muted">
                                        {formatLimitWindowName(window.windowMinutes)}
                                    </span>
                                    <span className="tabular-nums">
                                        {Math.round(window.usedPercent)}% used
                                        {window.resetsAt !== undefined && (
                                            <span className="text-muted">
                                                {' '}
                                                ·{' '}
                                                {formatLimitReset(
                                                    window.resetsAt,
                                                    report.generatedAt,
                                                )}
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <Progress
                                    aria-label={`${formatLimitWindowName(window.windowMinutes)} limit used`}
                                    value={window.usedPercent}
                                />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </ReportCard>
    );
}

function AgentsCard({ report }: { report: UsageReport }) {
    const total = report.totals.costUsd;
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
                                <span className="font-semibold tabular-nums">
                                    {formatUsd(row.costUsd)}
                                </span>
                            </div>
                            <ShareBar share={total > 0 ? row.costUsd / total : 0} />
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
export function UsageSections({ report, metric }: { report: UsageReport; metric: UsageMetric }) {
    const hasLimits = report.limits.length > 0;
    return (
        <div className="mx-auto grid max-w-6xl gap-3 p-4">
            <KpiTiles report={report} />
            <UsageActivityCard activity={report.activity} metric={metric} today={report.today} />
            <div className="grid gap-3 lg:grid-cols-2">
                <BurnCard report={report} />
                <HourOfDayCard report={report} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
                <AgentsCard report={report} />
                {hasLimits ? <LimitsCard report={report} /> : <InsightsCard report={report} />}
            </div>
            {hasLimits && <InsightsCard report={report} />}
            <UsageDetailCards report={report} />
            <CoverageNote report={report} />
        </div>
    );
}
