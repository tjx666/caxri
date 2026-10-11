import type { AgentProviderStatus, AgentProviderStatusIncident } from '@caxri/protocol';
import { ExternalLink } from 'lucide-react';

import { ReportCard } from '../../components/report-card';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useRelativeTime } from '../../hooks/use-relative-time';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast } from '../../stores/toasts';
import {
    describeProviderStatus,
    providerServiceStatusLabel,
    providerStatusFailureLabel,
} from './agent-provider-status-label';
import { ProviderStatusDot } from './provider-status-summary';

function openUrl(url: string) {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
    void openExternalUrl(url, (message) => pushToast('error', message));
}

function IncidentItem({ incident }: { incident: AgentProviderStatusIncident }) {
    const updatedAgo = useRelativeTime(incident.updatedAt);
    return (
        <li className="min-w-0 rounded-md border border-border px-3 py-2">
            <div className="flex min-w-0 items-baseline gap-2">
                <ProviderStatusDot className="translate-y-[-1px]" status={incident.status} />
                <button
                    className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[12px] font-semibold text-foreground hover:underline"
                    type="button"
                    onClick={() => openUrl(incident.url)}
                >
                    {incident.name}
                </button>
            </div>
            <div className="mt-1 text-[11px] text-muted">
                {[
                    incident.phase.charAt(0).toUpperCase() + incident.phase.slice(1),
                    providerServiceStatusLabel(incident.status),
                    incident.components.join(', '),
                    updatedAgo && `updated ${updatedAgo}`,
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
 * The Agent status tab's provider report: each watched status-page component, the open incidents touching them, and a
 * link to the full page. `undefined` is the first read still in flight; null is a provider without a status page.
 */
export function AgentProviderStatusSection({
    agentName,
    status,
}: {
    agentName: string;
    status: AgentProviderStatus | null | undefined;
}) {
    const checkedAgo = useRelativeTime(status?.checkedAt);
    if (status === null)
        return (
            <ReportCard title="API status">
                <p className="m-0 text-[12px] text-muted">
                    {agentName} has no public status page to read.
                </p>
            </ReportCard>
        );
    if (!status)
        return (
            <ReportCard title="API status">
                <p className="m-0 flex items-center gap-2 text-[12px] text-muted">
                    <Spinner aria-hidden="true" />
                    Checking the status page…
                </p>
            </ReportCard>
        );
    const openPage = (
        <Button size="sm" variant="secondary" onClick={() => openUrl(status.pageUrl)}>
            <ExternalLink aria-hidden="true" size={12} />
            Open status page
        </Button>
    );
    return (
        <ReportCard
            title={`${status.pageName} API status`}
            caption={checkedAgo && `Checked ${checkedAgo}`}
        >
            {status.state === 'unavailable' ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="m-0 text-[12px] text-muted">
                        {providerStatusFailureLabel(status.reason)}. Caxri tries again every half
                        minute.
                    </p>
                    {openPage}
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
                            <ProviderStatusDot className="size-2.5" status={status.status} />
                            <span className="min-w-0">{describeProviderStatus(status)}</span>
                        </div>
                        {openPage}
                    </div>
                    <ul className="m-0 mt-3 flex list-none flex-col divide-y divide-border p-0">
                        {status.components.map((component) => (
                            <li
                                key={component.name}
                                className="flex min-w-0 items-center justify-between gap-3 py-1.5 text-[12px]"
                            >
                                <span className="truncate">{component.name}</span>
                                <span className="flex flex-none items-center gap-1.5 text-muted">
                                    <ProviderStatusDot status={component.status} />
                                    {providerServiceStatusLabel(component.status)}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <h3 className="mt-4 mb-2 text-[12px] font-semibold">Active incidents</h3>
                    {status.incidents.length === 0 ? (
                        <p className="m-0 text-[12px] text-muted">
                            No open incident affects these components.
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
