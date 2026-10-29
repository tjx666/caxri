import type {
    AgentProvider,
    AgentProviderStatus,
    AgentThroughput,
    AgentThroughputSample,
} from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { Gauge } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';
import { useRelativeTime } from '@/hooks/use-relative-time';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useTerminal } from '../../stores/selectors';
import type { ProviderStatusAlert } from '../agent-status/agent-provider-status-label';
import {
    describeProviderStatus,
    providerStatusAlert,
} from '../agent-status/agent-provider-status-label';
import { openAgentStatusTab } from '../agent-status/open-agent-status-tab';
import { ProviderStatusSummary } from '../agent-status/provider-status-summary';
import { useAgentProviderStatus } from '../agent-status/use-agent-provider-status';
import {
    agentThroughputMethodNote,
    describeThroughputAggregate,
    describeThroughputSample,
    formatThroughputDuration,
    formatThroughputRate,
    isSameThroughputAggregate,
    recentAverageLabel,
    spokenThroughputRate,
    throughputRate,
} from './agent-throughput-label';
import { StatusItem } from './status-item';

const BAR_WIDTH = 4;
const BAR_GAP = 2;
const CHART_HEIGHT = 24;

/**
 * Per-response rates, oldest to newest, on a zero-based scale whose top is labelled so the bars read as values rather
 * than as a shape. The newest bar is drawn in the foreground ink; the rest stay muted.
 */
function ThroughputBars({ samples }: { samples: readonly AgentThroughputSample[] }) {
    const { t } = useTranslation();
    const rates = samples.map((sample) => throughputRate(sample) ?? 0);
    const max = Math.max(...rates);
    if (max <= 0) return null;
    const width = rates.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    return (
        <span className="flex items-end gap-1.5">
            <svg
                aria-hidden="true"
                className="flex-none"
                height={CHART_HEIGHT}
                viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                width={width}
            >
                {samples.map((sample, index) => {
                    const height = Math.max(1, (rates[index] / max) * CHART_HEIGHT);
                    return (
                        <rect
                            key={`${sample.completedAt}:${index}`}
                            className={
                                index === rates.length - 1 ? 'fill-foreground' : 'fill-muted'
                            }
                            height={height}
                            rx={1}
                            width={BAR_WIDTH}
                            x={index * (BAR_WIDTH + BAR_GAP)}
                            y={CHART_HEIGHT - height}
                        />
                    );
                })}
            </svg>
            <span className="text-muted tabular-nums">
                {t('statusBar.throughput.max', { rate: formatThroughputRate(max) })}
            </span>
        </span>
    );
}

/**
 * Literal fill classes for the alert dot: the SVG counterpart of the `bg-*` dots on the Agent status tab, spelled out
 * because Tailwind only generates utilities it finds in source.
 */
const ALERT_DOT_FILL_CLASS_NAMES: Record<ProviderStatusAlert['tone'], string> = {
    warning: 'fill-warning',
    danger: 'fill-danger',
};

/**
 * The chip's Gauge, with the provider alert dot drawn into the glyph's top-right corner. Drawing it inside the same SVG
 * keeps the chip's width fixed as the dot comes and goes (DESIGN.md principle 8), and the `--surface` ring cuts it out
 * of the gauge's arc so it reads as a badge on the glyph rather than as part of it. Lucide drops its default
 * `aria-hidden` once an icon has children, so the alert variant restores it: the chip's accessible name carries the
 * status in words.
 */
function ThroughputGlyph({ alert }: { alert: ProviderStatusAlert | undefined }) {
    if (!alert) return <Gauge />;
    return (
        <Gauge aria-hidden="true" data-provider-status={alert.tone}>
            <circle
                key="provider-status"
                className={cn(
                    ALERT_DOT_FILL_CLASS_NAMES[alert.tone],
                    // The ring matches what is behind the glyph: the status bar, or the chip's hover fill over it.
                    'stroke-surface [.statusbar-item:hover_&]:stroke-[color-mix(in_srgb,var(--foreground)_10%,var(--surface))]',
                )}
                cx={19}
                cy={5}
                r={4.5}
                strokeWidth={2}
            />
        </Gauge>
    );
}

/**
 * The chip before the Agent's first measured response, shown only while the provider's status page reports a problem: a
 * muted dash placeholder rate, so an incident is visible before the user's first prompt rather than only after a slow
 * answer.
 */
function UnmeasuredThroughputStatus({
    alert,
    provider,
    status,
    terminalId,
}: {
    alert: ProviderStatusAlert;
    provider: AgentProvider;
    status: Extract<AgentProviderStatus, { state: 'available' }>;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const agentName = agentProviderCatalog[provider].displayName;
    const tabLabel = t('editor.tab.agentStatus', { agent: agentName });
    return (
        <StatusItem
            ariaLabel={t('statusBar.throughput.unmeasuredAriaLabel', {
                tab: tabLabel,
                agent: agentName,
                status: describeProviderStatus(status, t),
            })}
            className="statusbar-agent-throughput text-muted [&>span]:min-w-[8ch]"
            icon={<ThroughputGlyph alert={alert} />}
            onClick={() => openAgentStatusTab(terminalId)}
            title={
                <StructuredTooltip
                    eyebrow={t('statusBar.throughput.eyebrow', { agent: agentName })}
                    title={t('statusBar.throughput.notMeasured')}
                    details={[t('statusBar.throughput.shownForProviderProblem')]}
                    rows={[
                        {
                            label: t('statusBar.throughput.apiStatus'),
                            value: <ProviderStatusSummary status={status} />,
                        },
                    ]}
                    notes={[agentThroughputMethodNote(t)]}
                    hint={t('statusBar.throughput.clickToOpen', { tab: tabLabel })}
                />
            }
        >
            —
        </StatusItem>
    );
}

/**
 * Output speed of the Agent in the active Terminal, measured from the provider's own transcript, with the provider's
 * public service status beside it so a slow Agent can be told apart from a provider incident: maintenance or degraded
 * performance marks the glyph with a `--warning` dot, an outage with a `--danger` one. Clicking opens the Terminal's
 * Agent status tab, the same tab `Show Agent Status` opens. Renders nothing for a Shell or an unsupported provider.
 * Before the first measured response it renders nothing either, unless the provider's status page reports a problem
 * (`UnmeasuredThroughputStatus`), so it never holds a slot to say "none".
 */
export function AgentThroughputStatus({
    isPaused,
    terminalId,
}: {
    /**
     * The chip is hidden by priority, so nobody reads its periodic refresh (see `isChipQueryUnread`).
     */
    isPaused: boolean;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const throughputQuery = usePolledQuery(
        'terminal.agentThroughput',
        { terminalId },
        {
            label: 'terminal.agentThroughput',
            intervalMs: 2_000,
            isPaused,
            staleTime: 1_000,
            retry: false,
        },
    );
    const throughput = throughputQuery.data;
    // The transcript names the provider once it exists; until then the Terminal record does.
    const terminalProvider = useTerminal(terminalId)?.provider;
    const provider = throughput?.provider ?? terminalProvider;
    const providerStatusQuery = useAgentProviderStatus(provider);
    const providerStatus = providerStatusQuery.data;
    const latest = throughput?.samples.at(-1);
    const rate = throughput ? throughputRate(throughput.recent) : undefined;
    const alert = providerStatusAlert(providerStatus, t);
    if (throughput && latest && rate !== undefined)
        return (
            <MeasuredThroughputStatus
                alert={alert}
                isProviderStatusError={providerStatusQuery.isError}
                latest={latest}
                providerStatus={providerStatus}
                rate={rate}
                terminalId={terminalId}
                throughput={throughput}
            />
        );
    if (!provider || !alert || providerStatus?.state !== 'available') return null;
    return (
        <UnmeasuredThroughputStatus
            alert={alert}
            provider={provider}
            status={providerStatus}
            terminalId={terminalId}
        />
    );
}

/**
 * The chip once the Agent has a measured response: the recent rate, with the tooltip's per-response breakdown.
 */
function MeasuredThroughputStatus({
    alert,
    isProviderStatusError,
    latest,
    providerStatus,
    rate,
    terminalId,
    throughput,
}: {
    alert: ProviderStatusAlert | undefined;
    isProviderStatusError: boolean;
    latest: AgentThroughputSample;
    providerStatus: AgentProviderStatus | null | undefined;
    rate: number;
    terminalId: string;
    throughput: AgentThroughput;
}) {
    const { t } = useTranslation();
    const lastResponseAgo = useRelativeTime(latest.completedAt);
    const label = formatThroughputRate(rate);
    const agentName = agentProviderCatalog[throughput.provider].displayName;
    const tabLabel = t('editor.tab.agentStatus', { agent: agentName });
    const averageLabel = recentAverageLabel(throughput.recent.responseCount, t);
    // The first turn of an Agent Session is the whole Agent Session: two identical rows read as two different facts.
    const isShowTurn =
        throughput.turn.responseCount > 0 &&
        !isSameThroughputAggregate(throughput.turn, throughput.session);
    return (
        <StatusItem
            ariaLabel={t(
                alert
                    ? 'statusBar.throughput.ariaLabelWithAlert'
                    : 'statusBar.throughput.ariaLabel',
                {
                    tab: tabLabel,
                    agent: agentName,
                    rate: spokenThroughputRate(rate, t),
                    average: averageLabel.toLowerCase(),
                    alert: alert?.label ?? '',
                },
            )}
            className="statusbar-agent-throughput [&>span]:min-w-[8ch]"
            icon={<ThroughputGlyph alert={alert} />}
            onClick={() => openAgentStatusTab(terminalId)}
            title={
                <StructuredTooltip
                    eyebrow={t('statusBar.throughput.eyebrow', { agent: agentName })}
                    title={label}
                    details={[averageLabel]}
                    rows={[
                        {
                            label: t('statusBar.throughput.lastResponse'),
                            value: (
                                <>
                                    {describeThroughputSample(latest, t)}
                                    {/* Kept on one line: `1 minute ago` split across two lines read as two facts. */}
                                    {lastResponseAgo && (
                                        <span className="whitespace-nowrap">
                                            , {lastResponseAgo}
                                        </span>
                                    )}
                                </>
                            ),
                        },
                        ...(isShowTurn
                            ? [
                                  {
                                      label: t('statusBar.throughput.thisTurn'),
                                      value: describeThroughputAggregate(throughput.turn, t),
                                  },
                              ]
                            : []),
                        ...(throughput.turnTimeToFirstTokenMs === undefined
                            ? []
                            : [
                                  {
                                      label: t('statusBar.throughput.firstToken'),
                                      value: t('statusBar.throughput.firstTokenValue', {
                                          duration: formatThroughputDuration(
                                              throughput.turnTimeToFirstTokenMs,
                                          ),
                                      }),
                                  },
                              ]),
                        {
                            label: t('statusBar.throughput.agentSession'),
                            value: describeThroughputAggregate(throughput.session, t),
                        },
                        ...(throughput.samples.length > 1
                            ? [
                                  {
                                      label: t('statusBar.throughput.lastSamples', {
                                          count: throughput.samples.length,
                                      }),
                                      value: <ThroughputBars samples={throughput.samples} />,
                                  },
                              ]
                            : []),
                        // Null means the provider publishes no status page; the row is left out rather than saying so.
                        ...(providerStatus === null
                            ? []
                            : [
                                  {
                                      label: t('statusBar.throughput.apiStatus'),
                                      value: (
                                          <ProviderStatusSummary
                                              isError={isProviderStatusError}
                                              status={providerStatus}
                                          />
                                      ),
                                  },
                              ]),
                    ]}
                    notes={[agentThroughputMethodNote(t)]}
                    hint={t('statusBar.throughput.clickToOpen', { tab: tabLabel })}
                />
            }
        >
            {label}
        </StatusItem>
    );
}
