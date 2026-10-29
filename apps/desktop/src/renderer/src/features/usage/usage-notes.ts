import type { UsageReport } from '@caxri/protocol';
import { formatPercent, formatTokens, formatUsd } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { formatCount } from '../../lib/locale-format';
import { localizedDuration } from '../../lib/usage-format';
import {
    activityHighlights,
    countLabel,
    formatDate,
    formatTimestampDate,
    WEEKDAYS,
} from './usage-metrics';

/**
 * The Usage page's prose: the coverage footnotes under the report and the Highlights card's sentences. Kept apart from
 * `usage-metrics.ts`, which owns the report's derived figures.
 */
/**
 * The footnotes under the report: what it counts, what it is missing, and why.
 */
export function usageCoverageNotes(
    t: Translate,
    report: Pick<UsageReport, 'coverage' | 'pricing' | 'scope'>,
): string[] {
    const { coverage, pricing } = report;
    const counted = t('usage.coverage.counted', {
        agentSessions: countLabel(t, coverage.agentSessions, 'agentSession'),
    });
    const outside = coverage.outsideCaxri?.agentSessions ?? 0;
    const source =
        pricing.source === 'bundled'
            ? t('usage.coverage.bundledPrices')
            : t('usage.coverage.liteLlmPrices', {
                  date: pricing.updatedAt
                      ? formatTimestampDate(t, pricing.updatedAt)
                      : t('usage.coverage.recently'),
              });
    const notes = [
        t('usage.coverage.priceBasis', { source }),
        report.scope === 'all'
            ? t('usage.coverage.countsWithOutside', {
                  counted,
                  outside: formatCount(outside, t.locale),
              })
            : t('usage.coverage.counts', { counted }),
    ];
    // An unread row has no aggregate yet either; only a finished scan proves the transcript is gone.
    if (coverage.unavailable > 0 && coverage.pendingScans === 0)
        notes.push(
            t(
                coverage.unavailable === 1
                    ? 'usage.coverage.unavailableOne'
                    : 'usage.coverage.unavailableOther',
                { count: formatCount(coverage.unavailable, t.locale) },
            ),
        );
    if (coverage.pendingPullRequests > 0)
        notes.push(
            t('usage.coverage.checkingPullRequests', {
                pullRequests: countLabel(t, coverage.pendingPullRequests, 'pullRequest'),
            }),
        );
    if (coverage.unpricedModels.length > 0)
        // Worded like every cost cell ("No price") rather than "$0", which read as "this usage was free".
        notes.push(
            t('usage.coverage.unpricedModels', { models: coverage.unpricedModels.join(', ') }),
        );
    return notes;
}

/**
 * The shortest Agent time an hourly rate is projected from. A few seconds of measured activity extrapolated to an hour
 * printed `144M output tokens per active hour` against a total of 2k tokens.
 */
const MIN_HOURLY_RATE_ACTIVE_MS = 60_000;

/**
 * The Highlights card's sentences, in display order. Each one appears only when its figure is meaningful.
 */
export function buildUsageInsights(
    t: Translate,
    report: Pick<UsageReport, 'activity' | 'models' | 'projects'> & {
        totals: Pick<
            UsageReport['totals'],
            'activeMs' | 'cacheSavingsUsd' | 'costUsd' | 'pullRequestsMerged'
        > & { tokens: Pick<UsageReport['totals']['tokens'], 'output'> };
    },
): string[] {
    const highlights = activityHighlights(report.activity);
    const { totals } = report;
    const topProject = report.projects.at(0);
    const topModel = report.models.at(0);
    const output = totals.tokens.output;
    const insights: string[] = [];
    const { busiestDay } = highlights;
    if (busiestDay)
        insights.push(
            t(
                busiestDay.costUsd > 0
                    ? 'usage.insights.busiestDayWithCost'
                    : 'usage.insights.busiestDay',
                {
                    cost: formatUsd(busiestDay.costUsd),
                    date: formatDate(t, busiestDay.date),
                    tokens: formatTokens(busiestDay.tokens),
                },
            ),
        );
    // "Day of the week", not "weekday": the busiest one is often a Saturday or Sunday.
    if (highlights.busiestWeekday !== undefined)
        insights.push(
            t('usage.insights.busiestWeekday', {
                weekday: t(WEEKDAYS[highlights.busiestWeekday]),
            }),
        );
    if (topProject && totals.costUsd > 0)
        insights.push(
            t('usage.insights.topProject', {
                percent: formatPercent(topProject.costUsd / totals.costUsd),
                project: topProject.title,
            }),
        );
    // A model whose spend is $0 (unpriced, or nothing billed yet) does not receive "most spend".
    if (topModel && topModel.costUsd > 0)
        insights.push(t('usage.insights.topModel', { model: topModel.model }));
    if (totals.cacheSavingsUsd > 0)
        insights.push(
            t('usage.insights.cacheSavings', {
                percent: formatPercent(
                    totals.cacheSavingsUsd / (totals.cacheSavingsUsd + totals.costUsd),
                ),
                savings: formatUsd(totals.cacheSavingsUsd),
            }),
        );
    if (output > 0 && totals.activeMs >= MIN_HOURLY_RATE_ACTIVE_MS) {
        const perHour = Math.round(output / (totals.activeMs / 3_600_000));
        insights.push(t('usage.insights.outputRate', { tokens: formatTokens(perHour) }));
    }
    if (totals.pullRequestsMerged > 0)
        insights.push(
            t('usage.insights.timePerPullRequest', {
                duration: localizedDuration(totals.activeMs / totals.pullRequestsMerged, t),
            }),
        );
    return insights;
}
