import type {
    AgentProviderServiceStatus,
    AgentProviderStatus,
    AgentProviderStatusIncident,
} from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import {
    describeProviderStatus,
    incidentPhaseLabel,
    providerStatusDotClassName,
    providerStatusFailureLabel,
    summarizeIncidents,
} from './agent-provider-status-label';

export function ProviderStatusDot({
    className,
    status,
}: {
    className?: string;
    status: AgentProviderServiceStatus;
}) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                'inline-block size-2 flex-none rounded-full',
                providerStatusDotClassName(status),
                className,
            )}
        />
    );
}

function IncidentLine({ incidents }: { incidents: readonly AgentProviderStatusIncident[] }) {
    const { first, moreLabel } = summarizeIncidents(incidents);
    if (!first) return null;
    return (
        <span className="flex min-w-0 gap-1.5 text-muted">
            <span className="min-w-0 truncate">
                {first.name} ({incidentPhaseLabel(first.phase)})
            </span>
            {moreLabel && <span className="flex-none">{moreLabel}</span>}
        </span>
    );
}

/**
 * The status-bar card's `API status` value: the watched components' state in one line, then the first open incident on
 * one truncated line with a `+N more` count; the Agent status tab lists them all. `undefined` is the first read still
 * in flight.
 */
export function ProviderStatusSummary({ status }: { status: AgentProviderStatus | undefined }) {
    if (!status) return <span className="text-muted">Checking…</span>;
    if (status.state === 'unavailable')
        return <span className="text-muted">{providerStatusFailureLabel(status.reason)}</span>;
    return (
        <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-1.5">
                {/* Nudged onto the text's x-height so the dot reads as part of the first line. */}
                <ProviderStatusDot className="translate-y-[-1px]" status={status.status} />
                <span>{describeProviderStatus(status)}</span>
            </span>
            <IncidentLine incidents={status.incidents} />
        </span>
    );
}
