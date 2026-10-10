import type { UsageReport } from '@caxri/protocol';
import { formatDuration, formatLineCount, formatTokens, formatUsd } from '@caxri/protocol';
import { Archive, GitMerge } from 'lucide-react';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import {
    cellClass,
    numericCellClass,
    numericHeadClass,
    ShareBar,
    tableHeadClass,
    UsageCard,
} from './usage-card';

function openPullRequest(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports failures through the shared toast path.
    void openExternalUrl(url, (message) => pushToast('error', message));
}

const MODEL_COLUMNS = ['Input', 'Output', 'Cache', 'Cost'];

function ModelsCard({ report }: { report: UsageReport }) {
    return (
        <UsageCard title="Models">
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
                        {report.models.slice(0, 12).map((row) => (
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
        </UsageCard>
    );
}

function ProjectsCard({ report }: { report: UsageReport }) {
    const top = report.projects.slice(0, 10);
    const peak = Math.max(0, ...top.map((row) => row.costUsd));
    return (
        <UsageCard
            title="Projects"
            caption={
                report.projects.length > top.length
                    ? `Top ${top.length} of ${report.projects.length}`
                    : undefined
            }
        >
            {top.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No Project usage in this range.</p>
            ) : (
                <div className="grid gap-3">
                    {top.map((row) => (
                        <div key={row.projectId} className="grid gap-1">
                            <div className="flex items-center justify-between gap-3 text-[12px]">
                                <span className={cn('truncate', row.isRemoved && 'text-muted')}>
                                    {row.title}
                                </span>
                                <span className="font-semibold tabular-nums">
                                    {formatUsd(row.costUsd)}
                                </span>
                            </div>
                            <ShareBar share={peak > 0 ? row.costUsd / peak : 0} />
                            <div className="flex justify-between gap-3 text-[11px] text-muted tabular-nums">
                                <span>
                                    {formatTokens(row.tokens)} tokens · {row.sessions}{' '}
                                    {row.sessions === 1 ? 'Session' : 'Sessions'}
                                </span>
                                <span>
                                    {formatDuration(row.activeMs)}
                                    {row.pullRequestsMerged > 0 &&
                                        ` · ${row.pullRequestsMerged} merged ${row.pullRequestsMerged === 1 ? 'PR' : 'PRs'}`}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </UsageCard>
    );
}

function SessionsCard({ report }: { report: UsageReport }) {
    const rows = report.sessions.slice(0, 15);
    return (
        <UsageCard title="Most expensive Sessions">
            {rows.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No Session usage in this range.</p>
            ) : (
                <table className="w-full table-fixed border-collapse">
                    <thead>
                        <tr>
                            <th className={tableHeadClass}>Session</th>
                            <th className={cn(tableHeadClass, 'w-40')}>Project</th>
                            <th className={cn(numericHeadClass, 'w-20')}>Tokens</th>
                            <th className={cn(numericHeadClass, 'w-20')}>Time</th>
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
                                        <span
                                            className={cn(
                                                'truncate',
                                                row.isDeleted && 'text-muted',
                                            )}
                                        >
                                            {row.title}
                                        </span>
                                        {row.isArchived && (
                                            <Archive
                                                aria-label="Archived"
                                                className="flex-none text-muted"
                                                size={12}
                                            />
                                        )}
                                        {row.pullRequestsMerged > 0 && (
                                            <span
                                                aria-label={`${row.pullRequestsMerged} merged pull requests`}
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
                                <td className={numericCellClass}>{formatUsd(row.costUsd)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </UsageCard>
    );
}

function PullRequestsCard({ report }: { report: UsageReport }) {
    const { pullRequestsMerged, linesAdded, linesDeleted, costUsd } = report.totals;
    return (
        <UsageCard
            title="Merged pull requests"
            caption={
                pullRequestsMerged > 0
                    ? `${formatUsd(costUsd / pullRequestsMerged)} per merged PR`
                    : undefined
            }
        >
            {report.pullRequests.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">
                    No pull request opened by an Agent was merged in this range.
                </p>
            ) : (
                <ul className="m-0 grid list-none gap-1 p-0">
                    {report.pullRequests.slice(0, 12).map((row) => (
                        <li key={row.url}>
                            <button
                                className="grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 rounded-sm px-1 py-1 text-left text-[12px] hover:bg-list-hover-background hover:text-list-hover-foreground"
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
            {pullRequestsMerged > 0 && (
                <p className="mt-2 mb-0 text-[11px] text-muted tabular-nums">
                    {pullRequestsMerged} merged · +{formatLineCount(linesAdded)} -
                    {formatLineCount(linesDeleted)} lines
                </p>
            )}
        </UsageCard>
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
