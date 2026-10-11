import type { AgentProviderServiceStatus, AgentProviderStatus } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import {
    describeProviderStatus,
    providerStatusDotClassName,
    providerStatusFailureLabel,
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

/**
 * The status-bar card's `API status` value: the watched components' state in one line, then each open incident's title.
 * `undefined` is the first read still in flight.
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
            {status.incidents.map((incident) => (
                <span key={incident.url} className="text-muted">
                    {incident.name} ({incident.phase})
                </span>
            ))}
        </span>
    );
}
