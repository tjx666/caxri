import { Fragment } from 'react';

import type { AgentChatTurnUsage } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { CircleDollarSign, Coins, Footprints } from 'lucide-react';

import { AnimatedNumber } from '../../../components/animated-number';
import { Tooltip } from '../../../components/ui/tooltip';
import type { Translate, TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatTurnMetric, AgentChatTurnMetricKind } from './agent-chat-turn-metrics';
import { agentChatTurnMetrics } from './agent-chat-turn-metrics';

const METRIC_ICONS: Record<AgentChatTurnMetricKind, LucideIcon> = {
    steps: Footprints,
    tokens: Coins,
    cost: CircleDollarSign,
};

const METRIC_TOOLTIPS = {
    turn: {
        steps: 'agentChat.activity.steps',
        tokens: 'agentChat.activity.tokens',
        cost: 'agentChat.activity.cost',
    },
    goal: {
        steps: 'agentChat.goal.steps',
        tokens: 'agentChat.goal.tokens',
        cost: 'agentChat.goal.cost',
    },
} as const satisfies Record<string, Record<AgentChatTurnMetricKind, TranslationKey>>;

/**
 * Where each row's figures yield to its width. The goal row also holds the goal's time, a status label once the goal is
 * not active, and three buttons, so its figures yield sooner than the status row's and the objective keeps its room.
 */
const NARROW_CLASSES = {
    turn: {
        list: '@max-[360px]:sr-only',
        divider: '@max-[480px]:hidden',
        figure: '@max-[480px]:sr-only',
    },
    goal: {
        list: '@max-[440px]:sr-only',
        divider: '@max-[560px]:hidden',
        figure: '@max-[560px]:sr-only',
    },
} as const satisfies Record<keyof typeof METRIC_TOOLTIPS, Record<string, string>>;

function metricTooltip(
    metric: AgentChatTurnMetric,
    scope: keyof typeof METRIC_TOOLTIPS,
    t: Translate,
): string {
    const key = METRIC_TOOLTIPS[scope][metric.kind];
    return t(key, metric.kind === 'cost' ? { value: metric.value } : { count: metric.value });
}

/**
 * What the running turn has spent so far, on the right of the composer's status row: steps, tokens, and estimated cost,
 * each a bare figure behind its icon and split by hairlines, with a pointer tooltip naming it (and the cost's currency:
 * the dollar glyph already says it, so the figure carries no `$`). The figures roll to each new value in tabular
 * digits, so a climbing count reads as progress and the row never shifts. The figures yield first when the row runs out
 * of width, because the row's left side says what the turn is doing and the badges stay clickable: a row under 480px
 * keeps only the token count, and one under 360px (a Chat pane around 400px wide) hides the figures, so the activity
 * text and elapsed time stay readable beside both badges (the goal row's figures yield sooner, `NARROW_CLASSES`).
 * Hidden figures turn `sr-only` rather than leaving the accessibility tree. The rolling digits are hidden from
 * assistive technology, which reads the tooltip's sentence from an `sr-only` copy instead (the figure's raw value, so a
 * screen reader hears the exact count while the eye sees the abbreviated one).
 */
export function AgentChatTurnMetricList({
    hasLeadingDivider = false,
    scope = 'turn',
    usage,
}: {
    /**
     * Rules the figures off from a figure before the list (the goal's time), with the same hairline that splits them.
     */
    hasLeadingDivider?: boolean;
    /**
     * Whose spend the figures are, for their tooltips: the running turn's, or the goal's across its turns.
     */
    scope?: keyof typeof METRIC_TOOLTIPS;
    usage: Pick<AgentChatTurnUsage, 'requests' | 'totalTokens' | 'costUsd'> | undefined;
}) {
    const { t } = useTranslation();
    const metrics = agentChatTurnMetrics(usage);
    if (metrics.length === 0) return null;
    const narrow = NARROW_CLASSES[scope];
    return (
        <span className={cn('flex shrink-0 items-center gap-2.5 text-[11px]', narrow.list)}>
            {metrics.map((metric, index) => {
                const Icon = METRIC_ICONS[metric.kind];
                const isNarrowHidden = metric.kind !== 'tokens';
                return (
                    <Fragment key={metric.kind}>
                        {(index > 0 || hasLeadingDivider) && (
                            <span className={cn('h-3 w-px shrink-0 bg-border', narrow.divider)} />
                        )}
                        <Tooltip content={metricTooltip(metric, scope, t)} side="top">
                            <span
                                className={cn(
                                    'inline-flex max-w-16 items-center gap-1 tabular-nums',
                                    isNarrowHidden && narrow.figure,
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
                                <span className="sr-only">{metricTooltip(metric, scope, t)}</span>
                            </span>
                        </Tooltip>
                    </Fragment>
                );
            })}
        </span>
    );
}
