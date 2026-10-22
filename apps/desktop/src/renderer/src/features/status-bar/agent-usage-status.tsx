import type { AgentUsageReadout } from '@caxri/protocol';
import {
    agentProviderCatalog,
    currentLimitWindows,
    defaultAppSettings,
    formatTokens,
    formatUsd,
    remainingLimitPercent,
} from '@caxri/protocol';
import { ChartColumn } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';
import { useRelativeTime } from '@/hooks/use-relative-time';

import { StructuredTooltip } from '../../components/structured-tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { localizedLimitReset, localizedLimitWindowName } from '../../lib/usage-format';
import { cn } from '../../lib/utilities';
import { useSettings } from '../../stores/selectors';
import { isPlanPaceDismissed, usePlanPaceDismissals } from '../usage/plan-pace-dismissals';
import { openUsagePageForTerminal } from '../usage/usage-page-request';
import {
    agentUsageCostLabel,
    agentUsageLabel,
    agentUsageLimitTone,
    agentUsagePaceNote,
} from './agent-usage-label';
import { useAgentUsageClock } from './hooks/use-agent-usage-clock';
import { StatusItem } from './status-item';

/**
 * `121k: 120k input, 900 output, 80k cache read`. Cache kinds the provider never reported are left out rather than
 * listed as zero.
 */
function describeTokens(tokens: AgentUsageReadout['tokens'], t: Translate): string {
    const parts = [
        t('statusBar.usage.tokensInput', { count: formatTokens(tokens.input) }),
        t('statusBar.usage.tokensOutput', { count: formatTokens(tokens.output) }),
    ];
    if (tokens.cacheRead > 0)
        parts.push(t('statusBar.usage.tokensCacheRead', { count: formatTokens(tokens.cacheRead) }));
    if (tokens.cacheWrite > 0)
        parts.push(
            t('statusBar.usage.tokensCacheWrite', { count: formatTokens(tokens.cacheWrite) }),
        );
    return t('statusBar.usage.tokensSummary', {
        total: formatTokens(tokens.total),
        parts: parts.join(t('statusBar.usage.listSeparator')),
    });
}

/**
 * Running tokens and estimated cost of the conversation in the active Agent Terminal, plus the newest account-wide
 * rate-limit window. Clicking opens the Usage page narrowed to this Terminal's Session, the closest unit the report
 * attributes usage to; a Terminal outside any Session opens the whole report. Renders nothing for a Shell or before the
 * conversation records any usage, so it never holds a slot to say "none".
 */
export function AgentUsageStatus({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    // Reads only `data`: the query tracks which fields render, and `dataUpdatedAt` advances on every 2-second poll.
    const { data: readout } = usePolledQuery(
        'terminal.agentUsage',
        { terminalId },
        { label: 'terminal.agentUsage', intervalMs: 2_000, staleTime: 1_000, retry: false },
    );
    const limitObservedAgo = useRelativeTime(readout?.limit?.observedAt);
    const now = useAgentUsageClock(readout?.limit);
    const settings = useSettings();
    const paceDismissals = usePlanPaceDismissals((state) => state.dismissedOn);
    if (!readout) return null;
    const chipOptions = {
        showFiveHourLimit:
            settings?.['statusBar.usage.showFiveHourLimit'] ??
            defaultAppSettings['statusBar.usage.showFiveHourLimit'],
    };
    const label = agentUsageLabel(readout, now, chipOptions, t);
    const agentName = agentProviderCatalog[readout.provider].displayName;
    const { tokens } = readout;
    const cost = agentUsageCostLabel(readout);
    const limitWindows = currentLimitWindows(readout.limit, now);
    const isPaceDismissed = isPlanPaceDismissed(paceDismissals, readout.provider, now);
    const limitTone = agentUsageLimitTone(readout, now, chipOptions, isPaceDismissed);
    // The pace note explains why the chip warns; once the user dismisses that warning the tooltip stops repeating it.
    const paceNote = isPaceDismissed ? undefined : agentUsagePaceNote(readout, now, t);
    return (
        <StatusItem
            ariaLabel={t('statusBar.usage.ariaLabel', { agent: agentName, label })}
            className={cn('statusbar-agent-usage', limitTone === 'warning' && 'text-warning')}
            icon={<ChartColumn />}
            isUrgent={limitTone === 'warning'}
            onClick={() => openUsagePageForTerminal(terminalId)}
            title={
                <StructuredTooltip
                    eyebrow={t('statusBar.usage.eyebrow', { agent: agentName })}
                    title={label}
                    rows={[
                        { label: t('statusBar.usage.tokens'), value: describeTokens(tokens, t) },
                        {
                            label: t('statusBar.usage.estimatedCost'),
                            value: cost
                                ? readout.unpricedModels.length > 0
                                    ? t('statusBar.usage.partialCost', {
                                          cost: formatUsd(readout.costUsd),
                                      })
                                    : formatUsd(readout.costUsd)
                                : t('statusBar.usage.noPrice'),
                        },
                        ...(cost && readout.unpricedModels.length > 0
                            ? [
                                  {
                                      label: t('statusBar.usage.noPrice'),
                                      value: readout.unpricedModels.join(', '),
                                  },
                              ]
                            : []),
                        { label: t('statusBar.usage.models'), value: readout.models.join(', ') },
                        ...limitWindows.map((window) => {
                            const used = t('statusBar.usage.limitLeft', {
                                percent: remainingLimitPercent(window.usedPercent),
                            });
                            return {
                                label: t('statusBar.usage.limit', {
                                    window: localizedLimitWindowName(window.windowMinutes, t),
                                }),
                                value:
                                    window.resetsAt === undefined
                                        ? used
                                        : `${used} · ${localizedLimitReset(window.resetsAt, now, t)}`,
                            };
                        }),
                        ...(limitObservedAgo && limitWindows.length > 0
                            ? [{ label: t('statusBar.usage.limitsAsOf'), value: limitObservedAgo }]
                            : []),
                    ]}
                    notes={[...(paceNote ? [paceNote] : []), t('statusBar.usage.methodNote')]}
                    hint={t('statusBar.usage.clickToOpen')}
                />
            }
        >
            {label}
        </StatusItem>
    );
}
