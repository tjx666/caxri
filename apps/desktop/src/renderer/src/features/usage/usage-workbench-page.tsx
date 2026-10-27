import { useEffect, useState } from 'react';

import type {
    AgentProvider,
    UsageRange,
    UsageReport,
    UsageScope,
    UsageSessionRow,
} from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { ChartColumn, RefreshCw, X } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { Spinner } from '../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import type { Translate, TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { useSessionById } from '../../stores/selectors';
import type { UsageCustomRange } from './usage-custom-range';
import type { UsageAgentFilter } from './usage-filter-store';
import { ALL_AGENTS, rememberUsageFilters, useUsageFilterStore } from './usage-filter-store';
import {
    didUsageRefreshFail,
    formatDate,
    usageEmptyState,
    usageLoadFailureText,
    usageRangeLabel,
    usageScanCaption,
} from './usage-metrics';
import { useUsagePageRequestStore } from './usage-page-request';
import { usageSessionFilterTitle } from './usage-presentation';
import { UsageRangePicker } from './usage-range-picker';
import { UsageSections } from './usage-sections';
import { useUsageReport } from './use-usage-report';

const SCOPES: ReadonlyArray<{
    value: UsageScope;
    labelKey: TranslationKey;
    descriptionKey: TranslationKey;
}> = [
    {
        value: 'caxri',
        labelKey: 'usage.scope.caxri',
        descriptionKey: 'usage.scope.caxriDescription',
    },
    {
        value: 'all',
        labelKey: 'usage.scope.thisMac',
        descriptionKey: 'usage.scope.thisMacDescription',
    },
];

/**
 * Read once: a report's day boundaries only need to match the zone the user saw when the page loaded.
 */
const LOCAL_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * The date range plus the price basis: every dollar figure below is an API list-price estimate, not what a subscription
 * plan bills, and the page header is the one line every card sits under.
 */
function rangeCaption(t: Translate, report: UsageReport): string {
    const end = report.rangeEnd ?? report.today;
    const range = !report.rangeStart
        ? t('usage.caption.allTime', { end: formatDate(t, end) })
        : report.rangeStart === end
          ? formatDate(t, end)
          : t('usage.caption.range', {
                end: formatDate(t, end),
                start: formatDate(t, report.rangeStart),
            });
    const scan = usageScanCaption(t, report);
    return `${range} · ${t('usage.caption.priceBasis')}${scan ? ` · ${scan}` : ''}`;
}

function UsageBody({
    report,
    agent,
    onShowAllAgents,
    onShowThisMac,
}: {
    report: UsageReport;
    agent: AgentProvider | undefined;
    onShowAllAgents: () => void;
    /**
     * Present only in the Caxri scope: an empty Caxri report often sits beside Agent work run in a plain terminal, and
     * the scope switch that reveals it is easy to miss in the header.
     */
    onShowThisMac?: () => void;
}) {
    const { t } = useTranslation();
    const empty = usageEmptyState(t, report, agent);
    if (empty?.kind === 'scanning')
        return <LoadingSkeleton variant="page" label={t('usage.empty.scanning')} />;
    if (empty?.kind === 'agentFilter')
        return (
            <Empty className="h-full">
                <EmptyMedia>
                    <ChartColumn aria-hidden="true" size={24} />
                </EmptyMedia>
                <EmptyTitle>{empty.title}</EmptyTitle>
                <Button size="sm" variant="secondary" onClick={onShowAllAgents}>
                    {t('usage.empty.showAllAgents')}
                </Button>
            </Empty>
        );
    if (empty?.kind === 'noUsage')
        return (
            <Empty className="h-full">
                <EmptyMedia>
                    <ChartColumn aria-hidden="true" size={24} />
                </EmptyMedia>
                <EmptyTitle>{t('usage.empty.noUsage')}</EmptyTitle>
                <p className="m-0 max-w-[420px] text-[12px] text-muted">
                    {t('usage.empty.noUsageDescription')}
                </p>
                {onShowThisMac && (
                    <Button size="sm" variant="secondary" onClick={onShowThisMac}>
                        {t('usage.empty.showThisMac')}
                    </Button>
                )}
            </Empty>
        );
    return <UsageSections report={report} />;
}

/**
 * The Session the report is narrowed to, as a removable filter: clicking it shows every Session again. The title falls
 * back to the report's own Session row once the Session itself is gone from the Workbench.
 */
function SessionFilterButton({
    onClear,
    reportRow,
    sessionId,
}: {
    onClear: () => void;
    reportRow: UsageSessionRow | undefined;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const title = usageSessionFilterTitle(t, {
        liveTitle: useSessionById(sessionId)?.title,
        reportRow,
        sessionId,
    });
    return (
        <Tooltip content={t('usage.filter.showAllSessions')}>
            <Button
                aria-label={t('usage.filter.sessionClear', { title })}
                className="max-w-80"
                data-usage-session-filter
                size="sm"
                variant="secondary"
                onClick={onClear}
            >
                <span className="truncate">{t('usage.filter.session', { title })}</span>
                <X aria-hidden="true" className="flex-none" size={12} />
            </Button>
        </Tooltip>
    );
}

/**
 * The report request for the page's current selection; an Agent or Session filter is sent only when one is set.
 */
function usageReportParameters({
    agent,
    custom,
    range,
    scope,
    sessionId,
}: {
    agent: UsageAgentFilter;
    custom: UsageCustomRange | undefined;
    range: UsageRange;
    scope: UsageScope;
    sessionId: string | undefined;
}) {
    return {
        timeZone: LOCAL_TIME_ZONE,
        range,
        ...(range === 'custom' && custom && { start: custom.start, end: custom.end }),
        scope,
        ...(agent !== ALL_AGENTS && { provider: agent }),
        ...(sessionId && { sessionId }),
    };
}

/**
 * The page title, followed by the removable Session filter while the report is narrowed to one Session.
 */
function UsageHeading({
    onClearSession,
    sessionReportRow,
    sessionId,
}: {
    sessionReportRow: UsageSessionRow | undefined;
    onClearSession: () => void;
    sessionId: string | undefined;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex min-w-0 items-center gap-2">
            <h1 className="m-0 text-[15px] font-semibold">{t('usage.title')}</h1>
            {sessionId && (
                <SessionFilterButton
                    reportRow={sessionReportRow}
                    sessionId={sessionId}
                    onClear={onClearSession}
                />
            )}
        </div>
    );
}

/**
 * The page's range and Session filter, seeded from and kept in step with requests the status bar usage chip leaves in
 * `useUsagePageRequestStore`.
 */
function useUsageSessionFilter() {
    const pendingRequest = useUsagePageRequestStore((state) => state.pending);
    const consumeRequest = useUsagePageRequestStore((state) => state.consumeUsagePageRequest);
    /**
     * A Session filter opens on all time: the status bar chip it comes from totals the whole conversation, so a shorter
     * window would greet the user with smaller figures than the ones they clicked. The initializers read the pending
     * request so the first report already carries the filter instead of loading the unfiltered page first. Without a
     * Session request the page opens on the range the user last picked; the Session's all-time view is not remembered.
     */
    const rememberedRange = useUsageFilterStore((state) => state.range);
    const custom = useUsageFilterStore((state) => state.custom);
    const [range, setPageRange] = useState<UsageRange>(
        pendingRequest?.sessionId ? 'all' : rememberedRange,
    );
    const setRange = (next: UsageRange, nextCustom?: UsageCustomRange) => {
        setPageRange(next);
        rememberUsageFilters(nextCustom ? { range: next, custom: nextCustom } : { range: next });
    };
    const [sessionId, setSessionId] = useState(pendingRequest?.sessionId);
    // A request arriving while the page is open is applied during render, React's pattern for state derived from a
    // changed input; the effect below only empties the store so a later mount does not apply it again.
    const [appliedRequest, setAppliedRequest] = useState(pendingRequest);
    if (pendingRequest && pendingRequest !== appliedRequest) {
        setAppliedRequest(pendingRequest);
        setSessionId(pendingRequest.sessionId);
        if (pendingRequest.sessionId) setPageRange('all');
    }
    useEffect(() => {
        if (pendingRequest) consumeRequest();
    }, [consumeRequest, pendingRequest]);
    return { custom, range, setRange, sessionId, setSessionId };
}

/**
 * Usage Workbench tab: token usage, estimated API cost, Agent time, and delivery outcomes for Agent Sessions started in
 * Caxri Sessions, or for every Agent Session on this Mac. A failed first read names a closed reason
 * (`usageLoadFailureReason`), never the Server's raw message. Everything is computed by the Server from local
 * transcripts; see `docs/usage.md`.
 */
export function UsageWorkbenchPage() {
    const { t } = useTranslation();
    const scope = useUsageFilterStore((state) => state.scope);
    const agent = useUsageFilterStore((state) => state.agent);
    const setScope = (next: UsageScope) => rememberUsageFilters({ scope: next });
    const setAgent = (next: UsageAgentFilter) => rememberUsageFilters({ agent: next });
    const { custom, range, setRange, sessionId, setSessionId } = useUsageSessionFilter();
    const query = useUsageReport(usageReportParameters({ agent, custom, range, scope, sessionId }));
    const report = query.data;
    /**
     * `keepPreviousData` keeps the last report on screen while a newly picked range, scope, or Agent loads, so the
     * caption names the selection right away and the body dims until its own figures arrive.
     */
    const isShowingPreviousSelection = query.isPlaceholderData;
    const retry = () => {
        void query.refetch();
    };

    return (
        // `p-px` keeps the header's fill off the pane's 1px inset focus ring, which it otherwise painted over.
        <div
            data-usage-page
            className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-px"
        >
            <div className="flex flex-wrap items-end justify-between gap-3 bg-surface pt-4 pr-4 pb-3 pl-4">
                <div className="min-w-0">
                    <UsageHeading
                        sessionId={sessionId}
                        sessionReportRow={report?.sessions.find(
                            (row) => row.sessionId === sessionId,
                        )}
                        onClearSession={() => setSessionId(undefined)}
                    />
                    <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                        {isShowingPreviousSelection ? (
                            <span className="inline-flex items-center gap-1.5">
                                {t('usage.caption.updating', {
                                    range: usageRangeLabel(t, range, custom),
                                })}
                                <Spinner aria-hidden="true" className="size-3" />
                            </span>
                        ) : report ? (
                            rangeCaption(t, report)
                        ) : (
                            t('usage.caption.default')
                        )}
                        {didUsageRefreshFail(query) && (
                            <>
                                {' · '}
                                <span className="text-danger">{t('usage.refreshFailed')}</span>
                                {' · '}
                                <button
                                    type="button"
                                    className="cursor-pointer rounded-sm border-0 bg-transparent p-0 text-[11px] text-foreground underline-offset-2 hover:underline focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                                    onClick={retry}
                                >
                                    {t('common.retry')}
                                </button>
                            </>
                        )}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <ToggleGroup
                        aria-label={t('usage.scope.label')}
                        value={[scope]}
                        onValueChange={(next: UsageScope[]) => {
                            if (next[0]) setScope(next[0]);
                        }}
                    >
                        {SCOPES.map((item) => (
                            <Tooltip key={item.value} content={t(item.descriptionKey)}>
                                <ToggleGroupItem value={item.value}>
                                    {t(item.labelKey)}
                                </ToggleGroupItem>
                            </Tooltip>
                        ))}
                    </ToggleGroup>
                    <ToggleGroup
                        aria-label={t('usage.filter.agent')}
                        value={[agent]}
                        onValueChange={(next: UsageAgentFilter[]) => {
                            if (next[0]) setAgent(next[0]);
                        }}
                    >
                        <ToggleGroupItem value={ALL_AGENTS}>
                            {t('usage.filter.allAgents')}
                        </ToggleGroupItem>
                        {agentProviderIds.map((provider) => (
                            <Tooltip
                                key={provider}
                                content={agentProviderCatalog[provider].displayName}
                            >
                                <ToggleGroupItem
                                    aria-label={agentProviderCatalog[provider].displayName}
                                    value={provider}
                                >
                                    <AgentIdentityIcon identity={provider} size={14} />
                                </ToggleGroupItem>
                            </Tooltip>
                        ))}
                    </ToggleGroup>
                    <UsageRangePicker custom={custom} range={range} onChange={setRange} />
                </div>
            </div>
            <div
                className={cn(
                    'min-h-0 overflow-y-auto transition-opacity',
                    isShowingPreviousSelection && 'opacity-50',
                )}
                aria-busy={query.isFetching}
            >
                {report ? (
                    <UsageBody
                        agent={agent === ALL_AGENTS ? undefined : agent}
                        report={report}
                        onShowAllAgents={() => setAgent(ALL_AGENTS)}
                        onShowThisMac={
                            scope === 'caxri' && !sessionId ? () => setScope('all') : undefined
                        }
                    />
                ) : query.isError ? (
                    <Empty className="h-full">
                        <EmptyTitle className="text-danger">{t('usage.loadFailed')}</EmptyTitle>
                        <p className="m-0 max-w-[420px] text-[12px] text-muted">
                            {usageLoadFailureText(t, query.error)}
                        </p>
                        <Button size="sm" variant="secondary" onClick={retry}>
                            <RefreshCw aria-hidden="true" size={12} />
                            {t('common.retry')}
                        </Button>
                    </Empty>
                ) : (
                    <LoadingSkeleton variant="page" label={t('usage.loading')} />
                )}
            </div>
        </div>
    );
}
