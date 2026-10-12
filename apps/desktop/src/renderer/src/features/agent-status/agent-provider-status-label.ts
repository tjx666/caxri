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

type ProviderStatusTone = 'danger' | 'success' | 'warning';

/**
 * DESIGN.md status-dot tokens: green while operational, amber while slow or in planned maintenance, red while down. The
 * one mapping behind both the Agent status tab's dots and the status-bar chip's alert dot.
 */
const STATUS_TONES: Record<AgentProviderServiceStatus, ProviderStatusTone> = {
    operational: 'success',
    maintenance: 'warning',
    degraded: 'warning',
    partialOutage: 'danger',
    majorOutage: 'danger',
};

/**
 * Literal class names, because Tailwind only generates utilities it can find spelled out in source.
 */
const TONE_DOT_CLASS_NAMES: Record<ProviderStatusTone, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
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
    return TONE_DOT_CLASS_NAMES[STATUS_TONES[status]];
}

/**
 * The alert a provider reading raises on the status-bar throughput chip, and the words that stand in for its color.
 */
export interface ProviderStatusAlert {
    /**
     * `API status: Partial outage`, the accessible twin of the dot. It reuses the tooltip row's `API status` label so
     * the spoken name and the hover card name the same fact the same way.
     */
    label: string;
    tone: Exclude<ProviderStatusTone, 'success'>;
}

/**
 * Only a reading that says something is wrong raises a dot: `warning` for maintenance or degraded performance, `danger`
 * for a partial or major outage. An operational provider, a first read still pending (`undefined`), a provider without
 * a status page (`null`), and a status page Caxri could not read (`unavailable`, which is no evidence of an incident)
 * all leave the chip unmarked.
 */
export function providerStatusAlert(
    status: AgentProviderStatus | null | undefined,
): ProviderStatusAlert | undefined {
    if (status?.state !== 'available') return undefined;
    const tone = STATUS_TONES[status.status];
    if (tone === 'success') return undefined;
    return { label: `API status: ${providerServiceStatusLabel(status.status)}`, tone };
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

/**
 * An incident's phase as both the status-bar card and the Agent status tab print it: `Identified`. The page words it in
 * lower case; one casing keeps the two surfaces reading as the same fact.
 */
export function incidentPhaseLabel(phase: string): string {
    return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/**
 * The status-bar card has room for one incident line: the first incident, and how many more the Agent status tab lists.
 */
export function summarizeIncidents<T>(incidents: readonly T[]): {
    first: T | undefined;
    moreLabel: string | undefined;
} {
    const more = incidents.length - 1;
    return { first: incidents[0], moreLabel: more > 0 ? `+${more} more` : undefined };
}

/**
 * Which branch a provider-status surface renders: `none` for a provider without a status page, `checking` while the
 * first read is in flight, `failed` when that read failed before any reading arrived (so the surface offers Retry
 * instead of saying "Checking" forever), and `ready` once a reading exists. A failed background refresh keeps the last
 * reading on screen.
 */
export type ProviderStatusView = 'none' | 'checking' | 'failed' | 'ready';

export function providerStatusView(
    status: AgentProviderStatus | null | undefined,
    isError: boolean,
): ProviderStatusView {
    if (status === null) return 'none';
    if (status) return 'ready';
    return isError ? 'failed' : 'checking';
}
