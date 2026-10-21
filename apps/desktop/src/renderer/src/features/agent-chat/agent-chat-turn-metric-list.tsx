import { Fragment } from 'react';

import type { AgentChatTurnUsage } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { CircleDollarSign, Coins, Footprints } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
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
 * What the running turn has spent so far, on the right of the composer strip: steps, tokens, and estimated cost, each
 * behind its icon and split by hairlines, with a pointer tooltip naming it. The figures tick in tabular digits so the
 * row never shifts. A narrow strip keeps only the token count. The strip is hidden from assistive technology; the Usage
 * page and the status bar carry the accessible figures.
 */
export function AgentChatTurnMetricList({
    className,
    usage,
}: {
    className?: string;
    usage: AgentChatTurnUsage | undefined;
}) {
    const { t } = useTranslation();
    const metrics = agentChatTurnMetrics(usage);
    if (metrics.length === 0) return null;
    return (
        <span className={cn('flex shrink-0 items-center gap-2.5 text-[11px]', className)}>
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
                            >
                                <Icon className="size-3.5 shrink-0" />
                                <span className="truncate">{metric.value}</span>
                            </span>
                        </Tooltip>
                    </Fragment>
                );
            })}
        </span>
    );
}
