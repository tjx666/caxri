import { useEffect, useState } from 'react';

import type { AgentProvider, UsageRange, UsageReport, UsageScope } from '@caxri/protocol';
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
import {
    didUsageRefreshFail,
    formatDate,
    usageEmptyState,
    usageLoadFailureText,
    usageRangeLabel,
    usageScanCaption,
} from './usage-metrics';
import { useUsagePageRequestStore } from './usage-page-request';
import { UsageSections } from './usage-sections';
import { useUsageReport } from './use-usage-report';

const RANGES: readonly UsageRange[] = ['7d', '30d', '90d', '365d', 'all'];
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
const ALL_AGENTS = 'all';
type AgentFilter = AgentProvider | typeof ALL_AGENTS;

/**
 * Read once: a report's day boundaries only need to match the zone the user saw when the page loaded.
 */
const LOCAL_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * The date range plus the price basis: every dollar figure below is an API list-price estimate, not what a subscription
 * plan bills, and the page header is the one line every card sits under.
 */
function rangeCaption(t: Translate, report: UsageReport): string {
    const range = report.rangeStart
        ? t('usage.caption.range', {
              end: formatDate(t, report.today),
              start: formatDate(t, report.rangeStart),
          })
        : t('usage.caption.allTime', { end: formatDate(t, report.today) });
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
    fallbackTitle,
    onClear,
    sessionId,
}: {
    fallbackTitle: string | undefined;
    onClear: () => void;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const title = useSessionById(sessionId)?.displayTitle ?? fallbackTitle ?? sessionId;
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
    range,
    scope,
    sessionId,
}: {
    agent: AgentFilter;
    range: UsageRange;
    scope: UsageScope;
    sessionId: string | undefined;
}) {
    return {
        timeZone: LOCAL_TIME_ZONE,
        range,
        scope,
        ...(agent !== ALL_AGENTS && { provider: agent }),
        ...(sessionId && { sessionId }),
    };
}

/**
 * The page title, followed by the removable Session filter while the report is narrowed to one Session.
 */
function UsageHeading({
    fallbackSessionTitle,
    onClearSession,
    sessionId,
}: {
    fallbackSessionTitle: string | undefined;
    onClearSession: () => void;
    sessionId: string | undefined;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex min-w-0 items-center gap-2">
            <h1 className="m-0 text-[15px] font-semibold">{t('usage.title')}</h1>
            {sessionId && (
                <SessionFilterButton
                    fallbackTitle={fallbackSessionTitle}
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
     * request so the first report already carries the filter instead of loading the unfiltered page first.
     */
    const [range, setRange] = useState<UsageRange>(pendingRequest?.sessionId ? 'all' : '30d');
    const [sessionId, setSessionId] = useState(pendingRequest?.sessionId);
    // A request arriving while the page is open is applied during render, React's pattern for state derived from a
    // changed input; the effect below only empties the store so a later mount does not apply it again.
    const [appliedRequest, setAppliedRequest] = useState(pendingRequest);
    if (pendingRequest && pendingRequest !== appliedRequest) {
        setAppliedRequest(pendingRequest);
        setSessionId(pendingRequest.sessionId);
        if (pendingRequest.sessionId) setRange('all');
    }
    useEffect(() => {
        if (pendingRequest) consumeRequest();
    }, [consumeRequest, pendingRequest]);
    return { range, setRange, sessionId, setSessionId };
}

/**
 * Usage Workbench tab: token usage, estimated API cost, Agent time, and delivery outcomes for Agent Sessions started in
 * Caxri Sessions, or for every Agent Session on this Mac. A failed first read names a closed reason
 * (`usageLoadFailureReason`), never the Server's raw message. Everything is computed by the Server from local
 * transcripts; see `docs/usage.md`.
 */
export function UsageWorkbenchPage() {
    const { t } = useTranslation();
    const [scope, setScope] = useState<UsageScope>('caxri');
    const { range, setRange, sessionId, setSessionId } = useUsageSessionFilter();
    const [agent, setAgent] = useState<AgentFilter>(ALL_AGENTS);
    const query = useUsageReport(usageReportParameters({ agent, range, scope, sessionId }));
    const report = query.data;
    /**
     * `keepPreviousData` keeps the last report on screen while a newly picked range, scope, or Agent loads, so the
     * caption names the selection right away and the body dims until its own figures arrive.
     */
    const isShowingPreviousSelection = query.isPlaceholderData;
    const retry = () => {
        // eslint-disable-next-line no-void -- a failed retry surfaces through the same error state.
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
                        fallbackSessionTitle={report?.sessions[0]?.title}
                        sessionId={sessionId}
                        onClearSession={() => setSessionId(undefined)}
                    />
                    <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                        {isShowingPreviousSelection ? (
                            <span className="inline-flex items-center gap-1.5">
                                {t('usage.caption.updating', {
                                    range: usageRangeLabel(t, range),
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
                        onValueChange={(next: AgentFilter[]) => {
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
                    <ToggleGroup
                        aria-label={t('usage.filter.range')}
                        value={[range]}
                        onValueChange={(next: UsageRange[]) => {
                            if (next[0]) setRange(next[0]);
                        }}
                    >
                        {RANGES.map((item) => (
                            <ToggleGroupItem key={item} value={item}>
                                {t(`usage.rangeShort.${item}`)}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
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
