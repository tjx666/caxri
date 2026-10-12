import type { UsageReport } from '@caxri/protocol';
import { formatLineCount, formatTokens, formatUsd } from '@caxri/protocol';
import { Archive, GitMerge } from 'lucide-react';

import { ReportCard } from '../../components/report-card';
import {
    cellClass,
    numericCellClass,
    numericHeadClass,
    tableHeadClass,
} from '../../components/report-table-classes';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { openExternalUrl } from '../../lib/external-link';
import { localizedDuration } from '../../lib/usage-format';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import { ShareBar } from './share-bar';
import { UsageCost } from './usage-cost';
import {
    countLabel,
    formatMetric,
    topCaption,
    usageCostDisplay,
    usageSessionCount,
} from './usage-metrics';
import { UsageModelName } from './usage-model-name';
import { usageRowStatusLabel, usageShare, usageShareBasis } from './usage-presentation';
import { UsageSessionTitle } from './usage-session-title';

function openPullRequest(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports failures through the shared toast path.
    void openExternalUrl(url, (message) => pushToast('error', message));
}

const MODEL_COLUMNS: readonly TranslationKey[] = [
    'usage.models.input',
    'usage.models.output',
    'usage.models.cache',
    'usage.cost.title',
];
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
    const { t } = useTranslation();
    return (
        <ReportCard
            title={t('usage.models.title')}
            caption={topCaption(
                t,
                Math.min(MODEL_ROWS, report.models.length),
                report.models.length,
            )}
        >
            {report.models.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('usage.models.empty')}</p>
            ) : (
                /*
                 * The model column keeps at least 10rem beside the four figures, so a narrow pane scrolls the table
                 * sideways instead of clipping every model name to the same couple of characters.
                 */
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[30rem] table-fixed border-collapse">
                        <thead>
                            <tr>
                                <th className={tableHeadClass}>{t('usage.models.model')}</th>
                                {MODEL_COLUMNS.map((label) => (
                                    <th key={label} className={cn(numericHeadClass, 'w-20')}>
                                        {t(label)}
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
                                            <UsageModelName model={row.model} />
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
                                            <span className="text-muted">
                                                {t('usage.cost.noPrice')}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </ReportCard>
    );
}

function ProjectsCard({ report }: { report: UsageReport }) {
    const top = report.projects.slice(0, PROJECT_ROWS);
    const basis = usageShareBasis(report);
    const total = { costUsd: report.totals.costUsd, tokens: report.totals.tokens.total };
    const { t } = useTranslation();
    return (
        <ReportCard
            title={t('usage.projects.title')}
            caption={topCaption(t, top.length, report.projects.length)}
        >
            {top.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('usage.projects.empty')}</p>
            ) : (
                <div className="grid gap-3">
                    {top.map((row) => {
                        const status = usageRowStatusLabel(t, { ...row, kind: 'project' });
                        return (
                            <div key={row.projectId} className="grid gap-1">
                                <div className="flex items-center justify-between gap-3 text-[12px]">
                                    <span className="flex min-w-0 items-baseline gap-2">
                                        <span
                                            className={cn(
                                                'truncate',
                                                (row.isRemoved || row.isOutsideCaxri) &&
                                                    'text-muted',
                                            )}
                                        >
                                            {row.title}
                                        </span>
                                        {status && (
                                            <span className="flex-none text-[11px] text-muted">
                                                {status}
                                            </span>
                                        )}
                                    </span>
                                    <UsageCost
                                        className="font-semibold"
                                        display={rowCost(report, row.costUsd, row.tokens)}
                                    />
                                </div>
                                <ShareBar share={usageShare(row, total, basis)} />
                                <div className="flex justify-between gap-3 text-[11px] text-muted tabular-nums">
                                    <span>
                                        {formatMetric(t, row.tokens, 'tokens')} ·{' '}
                                        {usageSessionCount(t, row.sessions, row.isOutsideCaxri)}
                                    </span>
                                    <span>
                                        {localizedDuration(row.activeMs, t)}
                                        {row.pullRequestsMerged > 0 &&
                                            ` · ${countLabel(t, row.pullRequestsMerged, 'mergedPullRequest')}`}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </ReportCard>
    );
}

function SessionsCard({ report }: { report: UsageReport }) {
    const rows = report.sessions.slice(0, SESSION_ROWS);
    const { t } = useTranslation();
    return (
        <ReportCard
            title={t('usage.sessions.title')}
            caption={topCaption(t, rows.length, report.sessions.length)}
        >
            {rows.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('usage.sessions.empty')}</p>
            ) : (
                /*
                 * Like the Models table: the title column keeps at least 10rem beside the fixed columns, and a narrow pane
                 * scrolls the table sideways instead of folding the header and pushing the last column past the card.
                 */
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[36rem] table-fixed border-collapse">
                        <thead>
                            <tr>
                                <th className={tableHeadClass}>{t('usage.sessions.session')}</th>
                                <th className={cn(tableHeadClass, 'w-40')}>
                                    {t('usage.sessions.project')}
                                </th>
                                <th className={cn(numericHeadClass, 'w-20')}>
                                    {t('usage.tokens')}
                                </th>
                                <th className={cn(numericHeadClass, 'w-24')}>
                                    {t('usage.agentTime.title')}
                                </th>
                                <th className={cn(numericHeadClass, 'w-20')}>
                                    {t('usage.cost.title')}
                                </th>
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
                                            {/* The text twin of the muted title, as on the Projects card. */}
                                            {usageRowStatusLabel(t, {
                                                ...row,
                                                kind: 'session',
                                            }) && (
                                                <span className="flex-none text-[11px] text-muted">
                                                    {usageRowStatusLabel(t, {
                                                        ...row,
                                                        kind: 'session',
                                                    })}
                                                </span>
                                            )}
                                            {row.isArchived && (
                                                <Archive
                                                    aria-label={t('usage.sessions.archived')}
                                                    className="flex-none text-muted"
                                                    size={12}
                                                />
                                            )}
                                            {row.pullRequestsMerged > 0 && (
                                                <span
                                                    aria-label={countLabel(
                                                        t,
                                                        row.pullRequestsMerged,
                                                        'mergedPullRequest',
                                                    )}
                                                    className="flex flex-none items-center gap-0.5 text-[11px] text-merged"
                                                >
                                                    <GitMerge aria-hidden="true" size={12} />
                                                    {row.pullRequestsMerged}
                                                </span>
                                            )}
                                        </span>
                                    </td>
                                    <td className={cn(cellClass, 'text-muted')}>
                                        {row.projectTitle}
                                    </td>
                                    <td className={numericCellClass}>{formatTokens(row.tokens)}</td>
                                    <td className={numericCellClass}>
                                        {localizedDuration(row.activeMs, t)}
                                    </td>
                                    <td className={numericCellClass}>
                                        <UsageCost
                                            display={rowCost(report, row.costUsd, row.tokens)}
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </ReportCard>
    );
}

function PullRequestsCard({ report }: { report: UsageReport }) {
    const { t } = useTranslation();
    const { pullRequestsMerged, costUsd } = report.totals;
    const shown = Math.min(PULL_REQUEST_ROWS, report.pullRequests.length);
    const captions = [
        topCaption(t, shown, report.pullRequests.length),
        pullRequestsMerged > 0 && costUsd > 0
            ? t('usage.pullRequests.costPerMerged', {
                  cost: formatUsd(costUsd / pullRequestsMerged),
              })
            : undefined,
    ].filter(Boolean);
    return (
        <ReportCard
            title={t('usage.pullRequests.title')}
            caption={captions.length > 0 ? captions.join(' · ') : undefined}
        >
            {report.pullRequests.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('usage.pullRequests.empty')}</p>
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
            <div className="grid gap-3 @3xl:grid-cols-2">
                <ProjectsCard report={report} />
                <PullRequestsCard report={report} />
            </div>
            <ModelsCard report={report} />
            <SessionsCard report={report} />
        </>
    );
}
