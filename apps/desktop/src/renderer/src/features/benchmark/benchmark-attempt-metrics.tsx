import type { BenchmarkAttempt, BenchmarkContextUsage } from '@caxri/protocol';
import { formatShortDuration, formatTokens } from '@caxri/protocol';

import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from '../../components/ui/tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { formatLatency, formatPercent, formatTokensPerSecond } from './benchmark-presentation';
import { cacheHitRate, contextRatio, tokensPerSecond } from './benchmark-results';

interface Measurement {
    key: string;
    label: string;
    /**
     * `undefined` reads as "Not available", never as zero.
     */
    value: string | undefined;
    hint?: string;
}

function contextValue(t: Translate, context: BenchmarkContextUsage, tokens: number): string {
    const window = context.compactWindow ?? context.window;
    const ratio = contextRatio(context, tokens);
    if (!window || ratio === undefined) return formatTokens(tokens);
    return `${t('benchmark.detail.contextOf', {
        tokens: formatTokens(tokens),
        window: formatTokens(window),
    })} · ${formatPercent(ratio)}`;
}

function measurements(t: Translate, attempt: BenchmarkAttempt): Measurement[] {
    const { tokens, context, generation } = attempt;
    const rows: Measurement[] = [];
    if (tokens) {
        const hitRate = cacheHitRate(tokens);
        rows.push(
            { key: 'input', label: t('benchmark.detail.input'), value: formatTokens(tokens.input) },
            {
                key: 'output',
                label: t('benchmark.detail.output'),
                value: formatTokens(tokens.output),
            },
            ...(tokens.reasoning > 0
                ? [
                      {
                          key: 'reasoning',
                          label: t('benchmark.detail.reasoning'),
                          value: formatTokens(tokens.reasoning),
                          hint: t('benchmark.detail.reasoningHint'),
                      },
                  ]
                : []),
            {
                key: 'cacheRead',
                label: t('benchmark.detail.cacheRead'),
                value: formatTokens(tokens.cacheRead),
            },
            {
                key: 'cacheWrite',
                label: t('benchmark.detail.cacheWrite'),
                value: formatTokens(tokens.cacheWrite),
            },
            {
                key: 'total',
                label: t('benchmark.detail.totalTokens'),
                value: formatTokens(tokens.total),
            },
            {
                key: 'cacheHitRate',
                label: t('benchmark.detail.cacheHitRate'),
                value: hitRate === undefined ? undefined : formatPercent(hitRate),
            },
        );
    }
    if (attempt.timeToFirstTokenMs !== undefined)
        rows.push({
            key: 'firstToken',
            label: t('benchmark.detail.firstToken'),
            value: formatLatency(attempt.timeToFirstTokenMs),
        });
    if (tokens || generation) {
        const speed = tokensPerSecond(attempt);
        rows.push({
            key: 'speed',
            label: t('benchmark.detail.speed'),
            value: speed === undefined ? undefined : formatTokensPerSecond(speed),
            hint: generation
                ? t('benchmark.detail.speedHint', {
                      tokens: formatTokens(generation.outputTokens),
                      duration: formatShortDuration(generation.durationMs) ?? '',
                  })
                : t('benchmark.detail.speedUnavailable'),
        });
    }
    if (context)
        rows.push(
            {
                key: 'contextPeak',
                label: t('benchmark.detail.contextPeak'),
                value: contextValue(t, context, context.peakTokens),
            },
            {
                key: 'contextFinal',
                label: t('benchmark.detail.contextFinal'),
                value: contextValue(t, context, context.finalTokens),
            },
        );
    if (attempt.compactions !== undefined)
        rows.push({
            key: 'compactions',
            label: t('benchmark.detail.compactions'),
            value: String(attempt.compactions),
        });
    return rows;
}

/**
 * The numbers one finished Attempt measured: its token breakdown, cache, speed, and context. A figure the Agent did not
 * report reads "Not available" rather than zero.
 */
export function BenchmarkAttemptMetrics({ attempt }: { attempt: BenchmarkAttempt }) {
    const { t } = useTranslation();
    const rows = measurements(t, attempt);
    if (rows.length === 0) return null;
    return (
        <section
            aria-label={t('benchmark.detail.measurements')}
            className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-4 gap-y-2"
            data-benchmark-attempt-metrics
        >
            {rows.map((row) => {
                const cell = (
                    <div
                        key={row.key}
                        className={cn('min-w-0', row.hint && FOCUSABLE_TOOLTIP_TRIGGER_CLASS)}
                        tabIndex={row.hint ? 0 : undefined}
                    >
                        <div className="truncate text-[11px] text-muted">{row.label}</div>
                        <div className="truncate text-[12px] tabular-nums">
                            {row.value ?? (
                                <span className="text-muted">
                                    {t('benchmark.detail.unavailable')}
                                </span>
                            )}
                        </div>
                    </div>
                );
                return row.hint ? (
                    <Tooltip key={row.key} content={row.hint}>
                        {cell}
                    </Tooltip>
                ) : (
                    cell
                );
            })}
        </section>
    );
}
