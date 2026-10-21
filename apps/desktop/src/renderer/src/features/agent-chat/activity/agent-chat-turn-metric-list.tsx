import { Fragment } from 'react';

import type { AgentChatTurnUsage } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { CircleDollarSign, Coins, Footprints } from 'lucide-react';

import { AnimatedNumber } from '../../../components/animated-number';
import { Tooltip } from '../../../components/ui/tooltip';
import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatTurnMetric, AgentChatTurnMetricKind } from './agent-chat-turn-metrics';
import { agentChatTurnMetrics } from './agent-chat-turn-metrics';

const METRIC_ICONS: Record<AgentChatTurnMetricKind, LucideIcon> = {
    steps: Footprints,
    tokens: Coins,
    cost: CircleDollarSign,
};

function metricTooltip(metric: AgentChatTurnMetric, t: Translate): string {
    if (metric.kind === 'steps') return t('agentChat.activity.steps', { count: metric.value });
    if (metric.kind === 'tokens') return t('agentChat.activity.tokens', { count: metric.value });
    return t('agentChat.activity.cost', { value: metric.value });
}

/**
 * What the running turn has spent so far, on the right of the composer's status row: steps, tokens, and estimated cost,
 * each a bare figure behind its icon and split by hairlines, with a pointer tooltip naming it (and the cost's currency:
 * the dollar glyph already says it, so the figure carries no `$`). The figures roll to each new value in tabular
 * digits, so a climbing count reads as progress and the row never shifts. A narrow strip keeps only the token count.
 * The figures are hidden from assistive technology; the Usage page and the status bar carry the accessible figures.
 */
export function AgentChatTurnMetricList({ usage }: { usage: AgentChatTurnUsage | undefined }) {
    const { t } = useTranslation();
    const metrics = agentChatTurnMetrics(usage);
    if (metrics.length === 0) return null;
    return (
        <span className="flex shrink-0 items-center gap-2.5 text-[11px]">
            {metrics.map((metric, index) => {
                const Icon = METRIC_ICONS[metric.kind];
                const isNarrowHidden = metric.kind !== 'tokens';
                return (
                    <Fragment key={metric.kind}>
                        {index > 0 && (
                            <span className="h-3 w-px shrink-0 bg-border @max-[360px]:hidden" />
                        )}
                        <Tooltip content={metricTooltip(metric, t)} side="top">
                            <span
                                className={cn(
                                    'inline-flex max-w-16 items-center gap-1 tabular-nums',
                                    isNarrowHidden && '@max-[360px]:hidden',
                                )}
                                data-agent-chat-turn-metric={metric.kind}
                                data-value={metric.value}
                            >
                                <Icon className="size-3.5 shrink-0" />
                                <AnimatedNumber
                                    fractionDigits={metric.figure.fractionDigits}
                                    suffix={metric.figure.suffix}
                                    value={metric.figure.value}
                                />
                            </span>
                        </Tooltip>
                    </Fragment>
                );
            })}
        </span>
    );
}
