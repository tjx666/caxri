import type {
    AgentProviderStatus,
    AgentProviderStatusComponent,
    AgentProviderStatusIncident,
} from '@caxri/protocol';
import { ExternalLink } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { ReportCard } from '../../components/report-card';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useRelativeTime } from '../../hooks/use-relative-time';
import { useTranslation } from '../../i18n';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import {
    describeProviderStatus,
    describeUptimeDay,
    incidentPhaseLabel,
    providerServiceStatusLabel,
    providerStatusFailureLabel,
    providerStatusView,
    providerUptimeBarClassName,
} from './agent-provider-status-label';
import { ProviderStatusDot } from './provider-status-summary';
import { formatUptimePercent, providerUptimeDays } from './provider-uptime';

function openUrl(url: string) {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
    void openExternalUrl(url, (message) => pushToast('error', message));
}

function IncidentItem({ incident }: { incident: AgentProviderStatusIncident }) {
    const updatedAgo = useRelativeTime(incident.updatedAt);
    const { t } = useTranslation();
    return (
        <li className="min-w-0 rounded-md border border-border px-3 py-2">
            <div className="flex min-w-0 items-baseline gap-2">
                <ProviderStatusDot className="translate-y-[-1px]" status={incident.status} />
                <button
                    className="flex min-w-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-left text-[12px] font-semibold text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={() => openUrl(incident.url)}
                >
                    <span className="min-w-0 truncate">{incident.name}</span>
                    <ExternalLink aria-hidden="true" className="flex-none text-muted" size={11} />
                </button>
            </div>
            <div className="mt-1 text-[11px] text-muted">
                {[
                    incidentPhaseLabel(incident.phase, t),
                    providerServiceStatusLabel(incident.status, t),
                    incident.components.join(', '),
                    updatedAgo && t('agentStatus.provider.updatedAgo', { time: updatedAgo }),
                ]
                    .filter(Boolean)
                    .join(' · ')}
            </div>
            {incident.latestUpdate && (
                <p className="mt-1.5 mb-0 text-[12px] leading-snug whitespace-pre-wrap">
                    {incident.latestUpdate}
                </p>
            )}
        </li>
    );
}

/**
 * One watched component: its current status and, when the page publishes history, the 90-day uptime figure over one bar
 * per local day, as status.openai.com draws it. Bars are not focus stops (90 would bury the page's other controls);
 * each carries its day and status as an accessible name, and the list's name says which component and window it
 * covers.
 */
function ComponentRow({ component }: { component: AgentProviderStatusComponent }) {
    const { t } = useTranslation();
    const { uptime } = component;
    const days = uptime ? providerUptimeDays(uptime) : [];
    const percent =
        uptime?.percent === undefined
            ? undefined
            : t('agentStatus.provider.uptime', { percent: formatUptimePercent(uptime.percent) });
    return (
        <li className="min-w-0 py-1.5 text-[12px]">
            <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="truncate">{component.name}</span>
                <span className="flex flex-none items-center gap-3 text-muted">
                    {percent && <span className="tabular-nums">{percent}</span>}
                    <span className="flex items-center gap-1.5">
                        <ProviderStatusDot status={component.status} />
                        {providerServiceStatusLabel(component.status, t)}
                    </span>
                </span>
            </div>
            {days.length > 0 && (
                <>
                    <ul
                        className="m-0 mt-2 flex h-7 list-none items-stretch gap-px p-0"
                        aria-label={t('agentStatus.provider.uptimeChartLabel', {
                            component: component.name,
                            count: days.length,
                        })}
                    >
                        {days.map((day) => {
                            const description = describeUptimeDay(day, t);
                            return (
                                <Tooltip key={day.start} content={description} hoverOnly>
                                    <li
                                        aria-label={description}
                                        className={cn(
                                            'min-w-0 flex-1 rounded-xs hover:opacity-70',
                                            providerUptimeBarClassName(day.status),
                                        )}
                                    />
                                </Tooltip>
                            );
                        })}
                    </ul>
                    <div
                        aria-hidden="true"
                        className="mt-1 flex justify-between text-[11px] text-muted"
                    >
                        <span>{t('agentStatus.provider.uptimeStart', { count: days.length })}</span>
                        <span>{t('agentStatus.provider.uptimeEnd')}</span>
                    </div>
                </>
            )}
        </li>
    );
}

/**
 * The Agent status tab's provider report: each watched status-page component, the open incidents touching them, and a
 * link to the full page. `undefined` is the first read still in flight, or a first read that failed (`isError`); null
 * is a provider without a status page.
 */
export function AgentProviderStatusSection({
    agentName,
    isError,
    onRetry,
    status,
}: {
    agentName: string;
    isError: boolean;
    onRetry: () => void;
    status: AgentProviderStatus | null | undefined;
}) {
    const checkedAgo = useRelativeTime(status?.checkedAt);
    const { t } = useTranslation();
    const view = providerStatusView(status, isError);
    if (view === 'failed')
        return (
            <ReportCard title={t('agentStatus.provider.title')}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="m-0 text-[12px] text-muted">
                        {t('agentStatus.provider.readFailed', { agent: agentName })}
                    </p>
                    <Button size="sm" variant="secondary" onClick={onRetry}>
                        {t('common.retry')}
                    </Button>
                </div>
            </ReportCard>
        );
    if (status === null)
        return (
            <ReportCard title={t('agentStatus.provider.title')}>
                <p className="m-0 text-[12px] text-muted">
                    {t('agentStatus.provider.noPage', { agent: agentName })}
                </p>
            </ReportCard>
        );
    if (!status)
        return (
            <ReportCard title={t('agentStatus.provider.title')}>
                {/* Shaped like the component rows that arrive, per DESIGN.md principle 9. */}
                <LoadingSkeleton
                    variant="list"
                    rows={3}
                    indent={0}
                    label={t('agentStatus.provider.checking')}
                />
            </ReportCard>
        );
    const openPage = (
        <Button size="sm" variant="secondary" onClick={() => openUrl(status.pageUrl)}>
            <ExternalLink aria-hidden="true" size={12} />
            {t('agentStatus.provider.openPage')}
        </Button>
    );
    return (
        <ReportCard
            title={t('agentStatus.provider.pageTitle', { page: status.pageName })}
            caption={checkedAgo && t('agentStatus.provider.checkedAgo', { time: checkedAgo })}
        >
            {status.state === 'unavailable' ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="m-0 text-[12px] text-muted">
                        {t('agentStatus.provider.unavailable', {
                            reason: providerStatusFailureLabel(status.reason, t),
                        })}
                    </p>
                    {openPage}
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
                            <ProviderStatusDot className="size-2.5" status={status.status} />
                            <span className="min-w-0">{describeProviderStatus(status, t)}</span>
                        </div>
                        {openPage}
                    </div>
                    <ul className="m-0 mt-3 flex list-none flex-col divide-y divide-border p-0">
                        {status.components.map((component) => (
                            <ComponentRow key={component.name} component={component} />
                        ))}
                    </ul>
                    <h3 className="mt-4 mb-2 text-[12px] font-semibold">
                        {t('agentStatus.provider.activeIncidents')}
                    </h3>
                    {status.incidents.length === 0 ? (
                        <p className="m-0 text-[12px] text-muted">
                            {t('agentStatus.provider.noIncidents')}
                        </p>
                    ) : (
                        <ul className="m-0 flex list-none flex-col gap-2 p-0">
                            {status.incidents.map((incident) => (
                                <IncidentItem key={incident.url} incident={incident} />
                            ))}
                        </ul>
                    )}
                </>
            )}
        </ReportCard>
    );
}
