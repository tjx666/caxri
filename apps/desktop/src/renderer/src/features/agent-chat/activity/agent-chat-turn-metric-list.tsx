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
 * digits, so a climbing count reads as progress and the row never shifts. The figures yield first when the row runs out
 * of width, because the row's left side says what the turn is doing and the badges stay clickable: a row under 480px
 * keeps only the token count, and one under 360px (a Chat pane around 400px wide) hides the figures, so the activity
 * text and elapsed time stay readable beside both badges. Hidden figures turn `sr-only` rather than leaving the
 * accessibility tree. The rolling digits are hidden from assistive technology, which reads the tooltip's sentence from
 * an `sr-only` copy instead (the figure's raw value, so a screen reader hears the exact count while the eye sees the
 * abbreviated one).
 */
export function AgentChatTurnMetricList({ usage }: { usage: AgentChatTurnUsage | undefined }) {
    const { t } = useTranslation();
    const metrics = agentChatTurnMetrics(usage);
    if (metrics.length === 0) return null;
    return (
        <span className="flex shrink-0 items-center gap-2.5 text-[11px] @max-[360px]:sr-only">
            {metrics.map((metric, index) => {
                const Icon = METRIC_ICONS[metric.kind];
                const isNarrowHidden = metric.kind !== 'tokens';
                return (
                    <Fragment key={metric.kind}>
                        {index > 0 && (
                            <span className="h-3 w-px shrink-0 bg-border @max-[480px]:hidden" />
                        )}
                        <Tooltip content={metricTooltip(metric, t)} side="top">
                            <span
                                className={cn(
                                    'inline-flex max-w-16 items-center gap-1 tabular-nums',
                                    isNarrowHidden && '@max-[480px]:sr-only',
                                )}
                                data-agent-chat-turn-metric={metric.kind}
                                data-value={metric.value}
                            >
                                <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                                <span aria-hidden="true" className="inline-flex">
                                    <AnimatedNumber
                                        fractionDigits={metric.figure.fractionDigits}
                                        suffix={metric.figure.suffix}
                                        value={metric.figure.value}
                                    />
                                </span>
                                <span className="sr-only">{metricTooltip(metric, t)}</span>
                            </span>
                        </Tooltip>
                    </Fragment>
                );
            })}
        </span>
    );
}
