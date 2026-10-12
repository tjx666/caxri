import type { AgentUsageReadout } from '@caxri/protocol';
import { agentProviderCatalog, formatTokens, formatUsd, usageTabPath } from '@caxri/protocol';
import { ChartColumn } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';
import { useRelativeTime } from '@/hooks/use-relative-time';

import { StructuredTooltip } from '../../components/structured-tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { localizedLimitReset, localizedLimitWindowName } from '../../lib/usage-format';
import { cn } from '../../lib/utilities';
import { openEditorTab } from '../editor/document-commands';
import {
    agentUsageCostLabel,
    agentUsageLabel,
    agentUsageLimitTone,
    currentLimitWindows,
} from './agent-usage-label';
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
 * rate-limit window. Clicking opens the Usage page. Renders nothing for a Shell or before the conversation records any
 * usage, so it never holds a slot to say "none".
 */
export function AgentUsageStatus({ terminalId }: { terminalId: string }) {
    const { t } = useTranslation();
    const { data: readout, dataUpdatedAt } = usePolledQuery(
        'terminal.agentUsage',
        { terminalId },
        { label: 'terminal.agentUsage', intervalMs: 2_000, staleTime: 1_000, retry: false },
    );
    const limitObservedAgo = useRelativeTime(readout?.limit?.observedAt);
    if (!readout) return null;
    // The poll time, not the render time, decides which limit windows have reset, keeping render pure.
    const now = dataUpdatedAt;
    const label = agentUsageLabel(readout, now);
    const agentName = agentProviderCatalog[readout.provider].displayName;
    const { tokens } = readout;
    const cost = agentUsageCostLabel(readout);
    const limitWindows = currentLimitWindows(readout.limit, now);
    const limitTone = agentUsageLimitTone(readout, now);
    return (
        <StatusItem
            ariaLabel={t('statusBar.usage.ariaLabel', { agent: agentName, label })}
            className={cn('statusbar-agent-usage', limitTone === 'warning' && 'text-warning')}
            icon={<ChartColumn />}
            onClick={() => openEditorTab(usageTabPath())}
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
                            const used = t('statusBar.usage.limitUsed', {
                                percent: Math.round(window.usedPercent),
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
                    notes={[t('statusBar.usage.methodNote')]}
                    hint={t('statusBar.usage.clickToOpen')}
                />
            }
        >
            {label}
        </StatusItem>
    );
}
