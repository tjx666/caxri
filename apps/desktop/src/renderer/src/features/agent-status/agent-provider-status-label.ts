import type {
    AgentProviderServiceStatus,
    AgentProviderStatus,
    AgentProviderStatusFailureReason,
} from '@caxri/protocol';

/**
 * The status page's own wording, so a user who opens the page reads the same phrase there.
 */
const STATUS_LABELS: Record<AgentProviderServiceStatus, string> = {
    operational: 'Operational',
    maintenance: 'Under maintenance',
    degraded: 'Degraded performance',
    partialOutage: 'Partial outage',
    majorOutage: 'Major outage',
};

/**
 * DESIGN.md status-dot tokens: green while operational, amber while slow or in planned maintenance, red while down.
 */
const STATUS_DOT_CLASS_NAMES: Record<AgentProviderServiceStatus, string> = {
    operational: 'bg-success',
    maintenance: 'bg-warning',
    degraded: 'bg-warning',
    partialOutage: 'bg-danger',
    majorOutage: 'bg-danger',
};

const FAILURE_LABELS: Record<AgentProviderStatusFailureReason, string> = {
    network: 'the status page could not be reached',
    http: 'the status page answered with an error',
    invalidResponse: 'the status page changed its format',
};

export function providerServiceStatusLabel(status: AgentProviderServiceStatus): string {
    return STATUS_LABELS[status];
}

export function providerStatusDotClassName(status: AgentProviderServiceStatus): string {
    return STATUS_DOT_CLASS_NAMES[status];
}

/**
 * `Status unavailable: the status page could not be reached`.
 */
export function providerStatusFailureLabel(reason: AgentProviderStatusFailureReason): string {
    return `Status unavailable: ${FAILURE_LABELS[reason]}`;
}

/**
 * One line for the status-bar card: `Operational` when every watched component is, otherwise the worst status and the
 * components that are not operational, such as `Partial outage: Codex API, CLI`.
 */
export function describeProviderStatus(
    status: Extract<AgentProviderStatus, { state: 'available' }>,
): string {
    const affected = status.components.filter((component) => component.status !== 'operational');
    const label = providerServiceStatusLabel(status.status);
    return affected.length === 0
        ? label
        : `${label}: ${affected.map((component) => component.name).join(', ')}`;
}
