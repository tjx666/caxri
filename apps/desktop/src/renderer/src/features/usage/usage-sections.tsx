import type { UsageReport } from '@caxri/protocol';
import {
    formatDuration,
    formatLineCount,
    formatPercent,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import { Progress } from '../../components/ui/progress';
import { cn } from '../../lib/utilities';
import { UsageActivityCard } from './usage-activity-card';
import { ProviderLabel, ShareBar, StatTile, UsageCard } from './usage-card';
import { UsageDetailCards } from './usage-detail-cards';
import type { UsageMetric } from './usage-metrics';
import {
    buildUsageInsights,
    burnRateCaption,
    computeStreaks,
    formatHour,
    peakHour,
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
                detail={`Across ${totals.sessionsWithUsage} ${totals.sessionsWithUsage === 1 ? 'Session' : 'Sessions'}`}
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
        <UsageCard title="Highlights">
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
        </UsageCard>
    );
}

function CoverageNote({ report }: { report: UsageReport }) {
    const { coverage, pricing } = report;
    const notes = [
        `Costs are estimated from public API list prices (${pricing.source === 'bundled' ? 'bundled price list' : `LiteLLM prices updated ${pricing.updatedAt ? new Date(pricing.updatedAt).toLocaleDateString() : 'recently'}`}); a subscription plan bills differently.`,
        `Counts ${coverage.agentSessions} Agent ${coverage.agentSessions === 1 ? 'conversation' : 'conversations'} started in Caxri Sessions, including archived and deleted Sessions.`,
    ];
    if (coverage.unavailable > 0)
        notes.push(
            `${coverage.unavailable} ${coverage.unavailable === 1 ? 'conversation has' : 'conversations have'} no transcript on this machine, so their usage is missing.`,
        );
    if (coverage.pendingPullRequests > 0)
        notes.push(`Checking ${coverage.pendingPullRequests} pull requests on GitHub.`);
    if (coverage.unpricedModels.length > 0)
        notes.push(`No price for ${coverage.unpricedModels.join(', ')}; counted as $0.`);
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
        <UsageCard title="Burn rate" caption={burnRateCaption(last30Days.costUsd)}>
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
        </UsageCard>
    );
}

function windowName(minutes: number): string {
    if (minutes === 10_080) return 'Weekly';
    if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour`;
    return `${minutes}-minute`;
}

function formatReset(at: number, now: number): string {
    const ms = at - now;
    if (ms <= 0) return 'resets now';
    const hours = Math.floor(ms / 3_600_000);
    // A weekly window reads better in days than as `95h 59m`.
    if (hours >= 48) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
    return `resets in ${formatDuration(ms)}`;
}

function LimitsCard({ report }: { report: UsageReport }) {
    if (report.limits.length === 0) return null;
    return (
        <UsageCard
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
                                        {windowName(window.windowMinutes)}
                                    </span>
                                    <span className="tabular-nums">
                                        {Math.round(window.usedPercent)}% used
                                        {window.resetsAt !== undefined && (
                                            <span className="text-muted">
                                                {' '}
                                                · {formatReset(window.resetsAt, report.generatedAt)}
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <Progress
                                    aria-label={`${windowName(window.windowMinutes)} limit used`}
                                    value={window.usedPercent}
                                />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </UsageCard>
    );
}

function AgentsCard({ report }: { report: UsageReport }) {
    const total = report.totals.costUsd;
    return (
        <UsageCard title="Agents">
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
                                    {row.sessions} {row.sessions === 1 ? 'Session' : 'Sessions'} ·{' '}
                                    {formatDuration(row.activeMs)}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </UsageCard>
    );
}

function HourOfDayCard({ report }: { report: UsageReport }) {
    const peak = Math.max(0, ...report.hourOfDay);
    const busiest = peakHour(report.hourOfDay);
    return (
        <UsageCard
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
                {report.hourOfDay.map((tokens, hour) => (
                    <div
                        key={hour}
                        className={cn('rounded-sm', tokens > 0 ? 'bg-success/60' : 'bg-elevated')}
                        style={{
                            height:
                                peak > 0 && tokens > 0
                                    ? `${Math.max(6, (tokens / peak) * 100)}%`
                                    : '6%',
                        }}
                    />
                ))}
            </div>
            <div aria-hidden="true" className="mt-1 grid grid-cols-4 text-[11px] text-muted">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
            </div>
        </UsageCard>
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
