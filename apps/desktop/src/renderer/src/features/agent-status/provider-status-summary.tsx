import type {
    AgentProviderServiceStatus,
    AgentProviderStatus,
    AgentProviderStatusIncident,
} from '@caxri/protocol';

import { useTranslation } from '../../i18n';
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
    const { t } = useTranslation();
    const { first, moreLabel } = summarizeIncidents(incidents, t);
    if (!first) return null;
    return (
        <span className="flex min-w-0 gap-1.5 text-muted">
            {/*
             * Only the name truncates: the phase says whether the incident was just identified or is nearly over, so
             * it stays whole beside the name's ellipsis, like the `+N more` count.
             */}
            <span className="flex min-w-0">
                <span className="min-w-0 truncate">{first.name}</span>
                <span className="flex-none whitespace-pre">
                    {t('agentStatus.incidentPhase', {
                        phase: incidentPhaseLabel(first.phase, t),
                    })}
                </span>
            </span>
            {moreLabel && <span className="flex-none">{moreLabel}</span>}
        </span>
    );
}

/**
 * The status-bar card's `API status` value: the watched components' state in one line, then the first open incident on
 * one line, whose name truncates before its phase does, with a `+N more` count; the Agent status tab lists them all.
 * `undefined` is the first read still in flight, or a first read that failed when `isError` is set.
 */
export function ProviderStatusSummary({
    isError = false,
    status,
}: {
    isError?: boolean;
    status: AgentProviderStatus | undefined;
}) {
    const { t } = useTranslation();
    if (!status)
        return (
            <span className="text-muted">
                {t(isError ? 'agentStatus.summary.readFailed' : 'agentStatus.summary.checking')}
            </span>
        );
    if (status.state === 'unavailable')
        return <span className="text-muted">{providerStatusFailureLabel(status.reason, t)}</span>;
    return (
        <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-1.5">
                {/* Nudged onto the text's x-height so the dot reads as part of the first line. */}
                <ProviderStatusDot className="translate-y-[-1px]" status={status.status} />
                <span>{describeProviderStatus(status, t)}</span>
            </span>
            <IncidentLine incidents={status.incidents} />
        </span>
    );
}
