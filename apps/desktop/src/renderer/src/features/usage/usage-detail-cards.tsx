import type { UsageReport } from '@caxri/protocol';
import { formatDuration, formatLineCount, formatTokens, formatUsd } from '@caxri/protocol';
import { Archive, GitMerge } from 'lucide-react';

import { ReportCard } from '../../components/report-card';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import { ShareBar } from './share-bar';
import { UsageCost } from './usage-cost';
import { countLabel, topCaption, usageCostDisplay, usageSessionCount } from './usage-metrics';
import { UsageSessionTitle } from './usage-session-title';
import {
    cellClass,
    numericCellClass,
    numericHeadClass,
    tableHeadClass,
} from './usage-table-classes';

function openPullRequest(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports failures through the shared toast path.
    void openExternalUrl(url, (message) => pushToast('error', message));
}

const MODEL_COLUMNS = ['Input', 'Output', 'Cache', 'Cost'];
const MODEL_ROWS = 12;
const PROJECT_ROWS = 10;
const SESSION_ROWS = 15;
const PULL_REQUEST_ROWS = 12;

/**
 * Projects and Sessions carry no per-model breakdown, so a row is only known to be unpriced when it has tokens but no
 * cost while the report lists unpriced models.
 */
function rowCost(report: UsageReport, costUsd: number, tokens: number) {
    return usageCostDisplay({
        costUsd,
        hasTokens: tokens > 0,
        hasUnpriced: report.coverage.unpricedModels.length > 0 && costUsd <= 0,
    });
}

function ModelsCard({ report }: { report: UsageReport }) {
    return (
        <ReportCard
            title="Models"
            caption={topCaption(Math.min(MODEL_ROWS, report.models.length), report.models.length)}
        >
            {report.models.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No model usage in this range.</p>
            ) : (
                <table className="w-full table-fixed border-collapse">
                    <thead>
                        <tr>
                            <th className={tableHeadClass}>Model</th>
                            {MODEL_COLUMNS.map((label) => (
                                <th key={label} className={cn(numericHeadClass, 'w-20')}>
                                    {label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {report.models.slice(0, MODEL_ROWS).map((row) => (
                            <tr key={`${row.provider}:${row.model}`}>
                                <td className={cellClass}>
                                    <span className="flex min-w-0 items-center gap-2">
                                        <AgentIdentityIcon identity={row.provider} size={12} />
                                        <span className="truncate font-mono text-[11px]">
                                            {row.model}
                                        </span>
                                    </span>
                                </td>
                                <td className={numericCellClass}>
                                    {formatTokens(row.tokens.input)}
                                </td>
                                <td className={numericCellClass}>
                                    {formatTokens(row.tokens.output)}
                                </td>
                                <td className={numericCellClass}>
                                    {formatTokens(row.tokens.cacheRead + row.tokens.cacheWrite)}
                                </td>
                                <td className={numericCellClass}>
                                    {row.isPriced ? (
                                        formatUsd(row.costUsd)
                                    ) : (
                                        <span className="text-muted">No price</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </ReportCard>
    );
}

function ProjectsCard({ report }: { report: UsageReport }) {
    const top = report.projects.slice(0, PROJECT_ROWS);
    const total = report.totals.costUsd;
    return (
        <ReportCard title="Projects" caption={topCaption(top.length, report.projects.length)}>
            {top.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No Project usage in this range.</p>
            ) : (
                <div className="grid gap-3">
                    {top.map((row) => (
                        <div key={row.projectId} className="grid gap-1">
                            <div className="flex items-center justify-between gap-3 text-[12px]">
                                <span
                                    className={cn(
                                        'truncate',
                                        (row.isRemoved || row.isOutsideCaxri) && 'text-muted',
                                    )}
                                >
                                    {row.title}
                                </span>
                                <UsageCost
                                    className="font-semibold"
                                    display={rowCost(report, row.costUsd, row.tokens)}
                                />
                            </div>
                            <ShareBar share={total > 0 ? row.costUsd / total : 0} />
                            <div className="flex justify-between gap-3 text-[11px] text-muted tabular-nums">
                                <span>
                                    {formatTokens(row.tokens)} tokens ·{' '}
                                    {usageSessionCount(row.sessions, row.isOutsideCaxri)}
                                </span>
                                <span>
                                    {formatDuration(row.activeMs)}
                                    {row.pullRequestsMerged > 0 &&
                                        ` · ${countLabel(row.pullRequestsMerged, 'merged pull request')}`}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </ReportCard>
    );
}

function SessionsCard({ report }: { report: UsageReport }) {
    const rows = report.sessions.slice(0, SESSION_ROWS);
    return (
        <ReportCard
            title="Most expensive Sessions"
            caption={topCaption(rows.length, report.sessions.length)}
        >
            {rows.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No Session usage in this range.</p>
            ) : (
                <table className="w-full table-fixed border-collapse">
                    <thead>
                        <tr>
                            <th className={tableHeadClass}>Session</th>
                            <th className={cn(tableHeadClass, 'w-40')}>Project</th>
                            <th className={cn(numericHeadClass, 'w-20')}>Tokens</th>
                            <th className={cn(numericHeadClass, 'w-24')}>Agent time</th>
                            <th className={cn(numericHeadClass, 'w-20')}>Cost</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.sessionId}>
                                <td className={cellClass}>
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span className="flex flex-none items-center gap-1">
                                            {row.providers.map((provider) => (
                                                <AgentIdentityIcon
                                                    key={provider}
                                                    identity={provider}
                                                    size={12}
                                                />
                                            ))}
                                        </span>
                                        <UsageSessionTitle row={row} />
                                        {row.isArchived && (
                                            <Archive
                                                aria-label="Archived"
                                                className="flex-none text-muted"
                                                size={12}
                                            />
                                        )}
                                        {row.pullRequestsMerged > 0 && (
                                            <span
                                                aria-label={countLabel(
                                                    row.pullRequestsMerged,
                                                    'merged pull request',
                                                )}
                                                className="flex flex-none items-center gap-0.5 text-[11px] text-merged"
                                            >
                                                <GitMerge aria-hidden="true" size={12} />
                                                {row.pullRequestsMerged}
                                            </span>
                                        )}
                                    </span>
                                </td>
                                <td className={cn(cellClass, 'text-muted')}>{row.projectTitle}</td>
                                <td className={numericCellClass}>{formatTokens(row.tokens)}</td>
                                <td className={numericCellClass}>{formatDuration(row.activeMs)}</td>
                                <td className={numericCellClass}>
                                    <UsageCost display={rowCost(report, row.costUsd, row.tokens)} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </ReportCard>
    );
}

function PullRequestsCard({ report }: { report: UsageReport }) {
    const { pullRequestsMerged, costUsd } = report.totals;
    const shown = Math.min(PULL_REQUEST_ROWS, report.pullRequests.length);
    const captions = [
        topCaption(shown, report.pullRequests.length),
        pullRequestsMerged > 0 && costUsd > 0
            ? `est. ${formatUsd(costUsd / pullRequestsMerged)} per merged pull request`
            : undefined,
    ].filter(Boolean);
    return (
        <ReportCard
            title="Merged pull requests"
            caption={captions.length > 0 ? captions.join(' · ') : undefined}
        >
            {report.pullRequests.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">
                    No pull request opened by an Agent was merged in this range.
                </p>
            ) : (
                <ul className="m-0 grid list-none gap-1 p-0">
                    {report.pullRequests.slice(0, PULL_REQUEST_ROWS).map((row) => (
                        <li key={row.url}>
                            <button
                                className="grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 rounded-sm px-1 py-1 text-left text-[12px] hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                                type="button"
                                onClick={() => openPullRequest(row.url)}
                            >
                                <GitMerge aria-hidden="true" className="text-merged" size={12} />
                                <span className="truncate">
                                    {row.title || `${row.repository}#${row.number}`}
                                    <span className="text-muted">
                                        {' '}
                                        {row.repository}#{row.number}
                                    </span>
                                </span>
                                <span className="text-[11px] tabular-nums">
                                    <span className="text-diff-stat-added">
                                        +{formatLineCount(row.additions)}
                                    </span>{' '}
                                    <span className="text-diff-stat-removed">
                                        -{formatLineCount(row.deletions)}
                                    </span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </ReportCard>
    );
}

/**
 * Where the spend went and what it delivered: Projects, merged pull requests, models, and the costliest Sessions.
 */
export function UsageDetailCards({ report }: { report: UsageReport }) {
    return (
        <>
            <div className="grid gap-3 lg:grid-cols-2">
                <ProjectsCard report={report} />
                <PullRequestsCard report={report} />
            </div>
            <ModelsCard report={report} />
            <SessionsCard report={report} />
        </>
    );
}
