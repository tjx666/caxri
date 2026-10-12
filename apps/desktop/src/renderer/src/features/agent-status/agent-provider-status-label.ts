import type {
    AgentProviderServiceStatus,
    AgentProviderStatus,
    AgentProviderStatusFailureReason,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { isTranslationKey, translate } from '../../i18n';

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

/**
 * The status page's own wording (`agentStatus.service.*`), so a user who opens the page reads the same phrase there.
 * Helpers here take an optional `t`: components pass `useTranslation().t` so they re-render on a language change, and
 * the default serves non-React callers and tests.
 */
export function providerServiceStatusLabel(
    status: AgentProviderServiceStatus,
    t: Translate = translate,
): string {
    return t(`agentStatus.service.${status}`);
}

export function providerStatusDotClassName(status: AgentProviderServiceStatus): string {
    return TONE_DOT_CLASS_NAMES[STATUS_TONES[status]];
}

/**
 * An uptime-strip day shares the dot's tones; a day before the page recorded the component reads as an empty slot.
 */
export function providerUptimeBarClassName(status: AgentProviderServiceStatus | 'noData'): string {
    return status === 'noData' ? 'bg-border' : providerStatusDotClassName(status);
}

const uptimeDayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * `Mar 9, 2026: Partial outage`, the day's tooltip and accessible name.
 */
export function describeUptimeDay(
    day: { start: number; status: AgentProviderServiceStatus | 'noData' },
    t: Translate = translate,
): string {
    return t('agentStatus.provider.uptimeDay', {
        date: uptimeDayFormat.format(day.start),
        status:
            day.status === 'noData'
                ? t('agentStatus.provider.uptimeNoData')
                : providerServiceStatusLabel(day.status, t),
    });
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
    t: Translate = translate,
): ProviderStatusAlert | undefined {
    if (status?.state !== 'available') return undefined;
    const tone = STATUS_TONES[status.status];
    if (tone === 'success') return undefined;
    return {
        label: t('agentStatus.alertLabel', {
            status: providerServiceStatusLabel(status.status, t),
        }),
        tone,
    };
}

/**
 * `Status unavailable: the status page could not be reached`.
 */
export function providerStatusFailureLabel(
    reason: AgentProviderStatusFailureReason,
    t: Translate = translate,
): string {
    return t(`agentStatus.failure.${reason}`);
}

/**
 * One line for the status-bar card: `Operational` when every watched component is, otherwise the worst status and the
 * components that are not operational, such as `Partial outage: Codex API, CLI`.
 */
export function describeProviderStatus(
    status: Extract<AgentProviderStatus, { state: 'available' }>,
    t: Translate = translate,
): string {
    const affected = status.components.filter((component) => component.status !== 'operational');
    const label = providerServiceStatusLabel(status.status, t);
    return affected.length === 0
        ? label
        : t('agentStatus.affectedComponents', {
              status: label,
              components: affected.map((component) => component.name).join(', '),
          });
}

/**
 * An incident's phase as both the status-bar card and the Agent status tab print it: `Identified`. The page words it in
 * lower case; one casing keeps the two surfaces reading as the same fact.
 */
export function incidentPhaseLabel(phase: string, t: Translate = translate): string {
    // Phases are open-ended page text; the common Statuspage phases are translated and anything else stays verbatim.
    const key = `agentStatus.phase.${phase}`;
    if (isTranslationKey(key)) return t(key);
    return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/**
 * The status-bar card has room for one incident line: the first incident, and how many more the Agent status tab lists.
 */
export function summarizeIncidents<T>(
    incidents: readonly T[],
    t: Translate = translate,
): {
    first: T | undefined;
    moreLabel: string | undefined;
} {
    const more = incidents.length - 1;
    return {
        first: incidents[0],
        moreLabel: more > 0 ? t('agentStatus.moreIncidents', { count: more }) : undefined,
    };
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
