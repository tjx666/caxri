import type {
    AgentProviderServiceStatus,
    AgentProviderStatus,
    AppLocale,
    MobileAgentThroughput,
    MobileAgentUsageProvider,
} from '@caxri/protocol';
import { limitPaceShortfall } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import type { AgentChatPlanLimitRow } from '../agent-chat/agent-chat-plan-limits';
import { agentChatPlanLimitRows } from '../agent-chat/agent-chat-plan-limits';
import { mobileAgentDisplayName } from '../sessions/agent-display-name';
import { relativeAgeLabel } from '../sessions/session-row-model';

/**
 * How often the open screen reads again. The Server re-reads a status page at most once a minute and asks a running
 * Claude Code Chat for its plan at most once a minute, so a faster poll would only repeat the same figures.
 */
export const AGENT_USAGE_POLL_MS = 30_000;

export type AgentUsageScreenState =
    | { kind: 'ready'; isStale: boolean }
    | { kind: 'loading' }
    | { kind: 'offline' }
    | { kind: 'error' };

/**
 * Which part of the Agent usage screen to draw. The query is disabled while the phone cannot observe the computer
 * (offline, backgrounded, or reconnecting), and a disabled query never leaves `pending`, so "no data and not
 * observable" must read as offline rather than as an endless loading state. A reading already on screen stays, marked
 * stale.
 */
export const agentUsageScreenState = ({
    hasData,
    isError,
    isObservable,
}: {
    hasData: boolean;
    isError: boolean;
    isObservable: boolean;
}): AgentUsageScreenState => {
    if (hasData) return { kind: 'ready', isStale: !isObservable };
    if (!isObservable) return { kind: 'offline' };
    return isError ? { kind: 'error' } : { kind: 'loading' };
};

/**
 * Below this a response's duration is transcript-timestamp noise, as on Desktop's tok/s chip.
 */
const MIN_THROUGHPUT_DURATION_MS = 250;

export type AgentUsageTone = 'success' | 'warning' | 'danger' | 'muted';

interface AgentUsageLimitRow extends AgentChatPlanLimitRow {
    /**
     * `Resets in 3h 20m · 14:30`: the countdown plus the clock time, so a reset days away still names its moment.
     */
    resetLabel: string | undefined;
}

interface AgentUsageIncident {
    key: string;
    name: string;
    /**
     * `Degraded performance · Investigating`.
     */
    detail: string;
    latestUpdate: string | undefined;
    url: string;
}

export interface AgentUsageCard {
    provider: MobileAgentUsageProvider['provider'];
    name: string;
    limits: AgentUsageLimitRow[];
    /**
     * `Updated 5m ago`, or why there is no reading.
     */
    limitNote: string;
    /**
     * The weekly pace warning Desktop's status bar and the Chat model sheet show.
     */
    pace: string | undefined;
    speed: { rate: string; source: string } | undefined;
    service:
        | {
              label: string;
              tone: AgentUsageTone;
              /**
               * `Degraded performance: Claude API`, one line per status worse than operational.
               */
              affected: string[];
              incidents: AgentUsageIncident[];
              /**
               * `Checked 1m ago`, or the reason the page could not be read.
               */
              note: string;
              pageUrl: string;
          }
        | undefined;
}

const serviceLabelKeys: Record<AgentProviderServiceStatus, TranslationKey> = {
    operational: 'usage.service.operational',
    maintenance: 'usage.service.maintenance',
    degraded: 'usage.service.degraded',
    partialOutage: 'usage.service.partialOutage',
    majorOutage: 'usage.service.majorOutage',
};

const serviceTones: Record<AgentProviderServiceStatus, AgentUsageTone> = {
    operational: 'success',
    maintenance: 'muted',
    degraded: 'warning',
    partialOutage: 'warning',
    majorOutage: 'danger',
};

const failureKeys = {
    network: 'usage.failure.network',
    http: 'usage.failure.http',
    invalidResponse: 'usage.failure.invalidResponse',
} as const satisfies Record<string, TranslationKey>;

/**
 * Status pages word phases in lower case (`investigating`); the screen starts them with a capital like a label.
 */
const phaseLabel = (phase: string): string => phase.charAt(0).toUpperCase() + phase.slice(1);

/**
 * The reset's clock time: `14:30` today, `Wed 14:30` later in the week, in the app's language.
 */
export function resetClockTime(at: number, now: number, locale: AppLocale): string {
    const isToday = new Date(at).toDateString() === new Date(now).toDateString();
    return new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...(!isToday && { weekday: 'short' }),
    }).format(at);
}

/**
 * Whole output tokens per second (`62 tok/s`, `<1 tok/s`), Desktop's chip format; nothing for a duration too short to
 * divide by.
 */
export function throughputRateLabel(
    throughput: Pick<MobileAgentThroughput, 'durationMs' | 'outputTokens'>,
): string | undefined {
    if (throughput.durationMs < MIN_THROUGHPUT_DURATION_MS || throughput.outputTokens <= 0)
        return undefined;
    const rate = throughput.outputTokens / (throughput.durationMs / 1_000);
    return `${rate < 1 ? '<1' : Math.round(rate).toLocaleString('en-US')}\u{A0}tok/s`;
}

function serviceCard(status: AgentProviderStatus, now: number, t: Translate) {
    const checked = t('usage.checkedAgo', { age: relativeAgeLabel(status.checkedAt, now, t) });
    if (status.state === 'unavailable')
        return {
            label: t('usage.service.unknown'),
            tone: 'muted' as const,
            affected: [],
            incidents: [],
            note: t(failureKeys[status.reason]),
            pageUrl: status.pageUrl,
        };
    const affected = new Map<AgentProviderServiceStatus, string[]>();
    for (const component of status.components)
        if (component.status !== 'operational')
            affected.set(component.status, [
                ...(affected.get(component.status) ?? []),
                component.name,
            ]);
    return {
        label: t(serviceLabelKeys[status.status]),
        tone: serviceTones[status.status],
        // Spread rather than iterator helpers: the runtime TypeScript target (ES2022) has no `Iterator.prototype.toArray`.
        affected: [...affected].map(([componentStatus, names]) =>
            t('usage.affectedComponents', {
                status: t(serviceLabelKeys[componentStatus]),
                components: names.join(', '),
            }),
        ),
        incidents: status.incidents.map((incident, index) => ({
            key: `${index}:${incident.url}`,
            name: incident.name,
            detail: t('usage.incidentPhase', {
                status: t(serviceLabelKeys[incident.status]),
                phase: phaseLabel(incident.phase),
            }),
            latestUpdate: incident.latestUpdate,
            url: incident.url,
        })),
        note: checked,
        pageUrl: status.pageUrl,
    };
}

function speedOf(throughput: MobileAgentThroughput | undefined, now: number, t: Translate) {
    const rate = throughput && throughputRateLabel(throughput);
    if (!throughput || !rate) return;
    const parameters = {
        session: throughput.sessionTitle,
        age: relativeAgeLabel(throughput.lastResponseAt, now, t),
    };
    return {
        rate,
        source:
            throughput.responseCount === 1
                ? t('usage.speedSourceOne', parameters)
                : t('usage.speedSource', { ...parameters, count: throughput.responseCount }),
    };
}

/**
 * One card per Agent on the Agent usage screen, in the Server's order.
 */
export function agentUsageCards(
    providers: readonly MobileAgentUsageProvider[],
    now: number,
    locale: AppLocale,
    t: Translate = translate,
): AgentUsageCard[] {
    return providers.map((entry) => {
        const name = mobileAgentDisplayName(entry.provider);
        const limits = agentChatPlanLimitRows(entry.limit, now, t).map((row) => ({
            ...row,
            resetLabel:
                row.reset && row.resetsAt !== undefined
                    ? t('usage.resetAt', {
                          reset: row.reset,
                          time: resetClockTime(row.resetsAt, now, locale),
                      })
                    : row.reset,
        }));
        const shortfall = limitPaceShortfall(entry.limit, now);
        const paceRow =
            shortfall && entry.limit
                ? agentChatPlanLimitRows(
                      { ...entry.limit, windows: [shortfall.window] },
                      now,
                      t,
                  ).at(0)
                : undefined;
        return {
            provider: entry.provider,
            name,
            limits,
            limitNote: entry.limit
                ? t('usage.limitUpdated', { age: relativeAgeLabel(entry.limit.observedAt, now, t) })
                : entry.provider === 'claude'
                  ? t('usage.noLimitClaude')
                  : t('usage.noLimit', { agent: name }),
            pace: paceRow
                ? t('chat.model.paceWarning', { limit: paceRow.label, left: paceRow.left })
                : undefined,
            speed: speedOf(entry.throughput, now, t),
            service: entry.serviceStatus ? serviceCard(entry.serviceStatus, now, t) : undefined,
        };
    });
}
