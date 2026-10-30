import type {
    AgentProvider,
    BenchmarkAttempt,
    BenchmarkCatalog,
    BenchmarkEntry,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    formatShortDuration,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import type { BenchmarkMetric, QualitySource } from './benchmark-results';

/**
 * Each Agent's chart hue, as a turn of the theme's one `--chart` color: the series follow an imported theme instead of
 * a fixed brand palette, and stay a quarter of the color wheel apart. Lightness and chroma are held to a band, because
 * a near-gray `--chart` would otherwise turn into near-gray series. The marker shape repeats the distinction, so color
 * is never the only cue.
 */
const SERIES_HUE_TURN: Record<AgentProvider, number> = {
    claude: 0,
    codex: 90,
    grok: 180,
    antigravity: 270,
};

export function seriesColor(provider: AgentProvider): string {
    return `oklch(from var(--chart) clamp(0.6, l, 0.78) max(c, 0.12) calc(h + ${SERIES_HUE_TURN[provider]}))`;
}

export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle';

const MARKER_SHAPES: Record<AgentProvider, MarkerShape> = {
    claude: 'circle',
    codex: 'square',
    grok: 'diamond',
    antigravity: 'triangle',
};

export function markerShape(provider: AgentProvider): MarkerShape {
    return MARKER_SHAPES[provider];
}

/**
 * The name a model goes by in the picker the user chose it from, falling back to its identifier once the catalog no
 * longer lists it (an older run, an Agent since signed out).
 */
export function modelLabel(
    catalog: BenchmarkCatalog | undefined,
    entry: Pick<BenchmarkEntry, 'model' | 'provider'>,
) {
    const model = catalog?.providers
        .find((provider) => provider.provider === entry.provider)
        ?.models.find(
            (candidate) => candidate.id === entry.model || candidate.resolvedId === entry.model,
        );
    return model?.displayName ?? entry.model;
}

/**
 * The judge as people name it: its Agent, then its model.
 */
export function judgeModelLabel(
    catalog: BenchmarkCatalog | undefined,
    judge: Pick<BenchmarkEntry, 'model' | 'provider'>,
): string {
    return `${agentProviderCatalog[judge.provider].displayName} · ${modelLabel(catalog, judge)}`;
}

export function metricLabel(t: Translate, metric: BenchmarkMetric): string {
    return t(`benchmark.metric.${metric}`);
}

export function qualityLabel(t: Translate, source: QualitySource): string {
    return t(
        source === 'check' ? 'benchmark.quality.checkPassRate' : 'benchmark.quality.judgeScore',
    );
}

function formatCount(value: number): string {
    return Number.isSafeInteger(value) ? String(value) : value.toFixed(1);
}

export function formatPercent(share: number): string {
    return `${Math.round(share * 100)}%`;
}

export function formatTokensPerSecond(value: number): string {
    return `${value < 10 && !Number.isSafeInteger(value) ? value.toFixed(1) : Math.round(value)}/s`;
}

function formatMetric(metric: BenchmarkMetric, value: number): string {
    switch (metric) {
        case 'cost': {
            return formatUsd(value);
        }
        case 'time': {
            return formatShortDuration(value) ?? '';
        }
        case 'outputTokens': {
            return formatTokens(value);
        }
        case 'steps': {
            return formatCount(value);
        }
        case 'timeToFirstToken': {
            return formatLatency(value);
        }
        case 'tokensPerSecond': {
            return formatTokensPerSecond(value);
        }
        case 'cacheHitRate': {
            return `${Math.round(value)}%`;
        }
    }
}

/**
 * A short wait: under a second in milliseconds, otherwise in seconds with one decimal under a minute.
 */
export function formatLatency(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
    if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
    return formatShortDuration(milliseconds) ?? '';
}

/**
 * A short axis tick: cost keeps more precision than the table, because the ticks of a cheap run sit a cent apart.
 */
export function formatTick(metric: BenchmarkMetric | 'quality', value: number): string {
    if (metric === 'quality') return String(Math.round(value));
    if (metric === 'cost')
        return value === 0 ? '$0' : `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
    return formatMetric(metric, value);
}

/**
 * The status line of one Attempt: its final state in words, with the reason a failed one ended.
 */
export function attemptStatusLabel(t: Translate, attempt: BenchmarkAttempt): string {
    if (attempt.status === 'failed' && attempt.failureReason)
        return t(`benchmark.failure.${attempt.failureReason}`);
    return t(`benchmark.status.${attempt.status}`);
}
