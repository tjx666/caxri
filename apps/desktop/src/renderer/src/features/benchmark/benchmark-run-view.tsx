import { useState } from 'react';

import type { BenchmarkCatalog, BenchmarkRun } from '@caxri/protocol';
import { formatShortDuration, formatTokens, formatUsd } from '@caxri/protocol';
import { RotateCcw, Square, Trash2 } from 'lucide-react';

import { ReportCard, StatTile } from '../../components/report-card';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from '../../components/ui/tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { formatDateTime } from '../../lib/locale-format';
import { cn } from '../../lib/utilities';
import { BenchmarkChart } from './benchmark-chart';
import { BenchmarkLeaderboard } from './benchmark-leaderboard';
import { judgeModelLabel, metricLabel, modelLabel } from './benchmark-presentation';
import { useTickingNow } from './benchmark-queries';
import type { BenchmarkMetric } from './benchmark-results';
import {
    buildChart,
    chartMetrics,
    configResults,
    qualitySource,
    rankResults,
    runSpend,
    runTokens,
} from './benchmark-results';
import { BenchmarkShareMenu } from './benchmark-share-menu';

function runCaption(
    t: Translate,
    run: BenchmarkRun,
    catalog: BenchmarkCatalog | undefined,
): string {
    const parts = [
        formatDateTime(run.createdAt),
        run.settings.workspace.kind === 'project'
            ? t('benchmark.run.inProject', {
                  project: run.projectTitle ?? t('benchmark.run.projectGone'),
                  commit: run.baseCommit?.slice(0, 7) ?? '',
              })
            : t('benchmark.run.inEmptyFolder'),
    ];
    if (run.settings.judge)
        parts.push(
            t('benchmark.run.judgedBy', {
                model: judgeModelLabel(catalog, run.settings.judge),
            }),
        );
    if (run.settings.checkCommand)
        parts.push(t('benchmark.run.checkedBy', { command: run.settings.checkCommand }));
    return parts.join(' · ');
}

function JudgeNotice({ run }: { run: BenchmarkRun }) {
    const { t } = useTranslation();
    if (!run.judge) return null;
    if (run.judge.status === 'running')
        return (
            <p className="m-0 inline-flex items-center gap-1.5 text-[12px] text-muted">
                <Spinner aria-hidden="true" className="size-3" />
                {t('benchmark.run.judging')}
            </p>
        );
    if (run.judge.status === 'failed')
        return (
            <p className="m-0 text-[12px] text-danger">
                {t('benchmark.run.judgeFailed', { message: run.judge.failureMessage ?? '' })}
            </p>
        );
    return null;
}

/**
 * One run's board: what was asked, the headline figures, the chart, and the ranked table, all live while it runs.
 */
export function BenchmarkRunView({
    run,
    catalog,
    onRunAgain,
    onCancel,
    onDelete,
}: {
    run: BenchmarkRun;
    catalog: BenchmarkCatalog | undefined;
    onRunAgain: () => void;
    onCancel: () => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation();
    const [metric, setMetric] = useState<BenchmarkMetric>('cost');
    const [highlighted, setHighlighted] = useState<number | undefined>();
    const now = useTickingNow(run.status === 'running');
    const results = configResults(run);
    const source = qualitySource(run, results);
    const metrics = chartMetrics(source);
    const xMetric = metrics.includes(metric) ? metric : metrics[0];
    const chart = buildChart(results, source, xMetric);
    const ranked = rankResults(results, source);
    const best =
        source === 'none' || run.status === 'running'
            ? undefined
            : ranked.find((result) => result.completed > 0);
    const spend = runSpend(run);
    const tokens = runTokens(run);
    const completed = run.attempts.filter((attempt) => attempt.status === 'completed').length;
    const wallMs = (run.finishedAt ?? now) - run.createdAt;
    const unplottedNames = results
        .filter(
            (result) =>
                result.completed > 0 &&
                chart.points.every((point) => point.entryIndex !== result.entryIndex),
        )
        .map(
            (result) =>
                `${modelLabel(catalog, result.entry)}${result.entry.effort ? ` ${result.entry.effort}` : ''}`,
        );
    return (
        <div
            className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-5 pb-8"
            data-benchmark-run={run.id}
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <Tooltip content={run.prompt}>
                        <h1
                            className={cn(
                                'm-0 truncate text-[15px] font-semibold',
                                FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                            )}
                            tabIndex={0}
                        >
                            {run.title}
                        </h1>
                    </Tooltip>
                    <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                        {runCaption(t, run, catalog)}
                    </p>
                </div>
                <div className="flex flex-none items-center gap-2">
                    {run.status === 'running' ? (
                        <Button
                            data-benchmark-cancel
                            size="sm"
                            variant="secondary"
                            onClick={onCancel}
                        >
                            <Square aria-hidden="true" size={11} />
                            {t('benchmark.run.cancel')}
                        </Button>
                    ) : (
                        <>
                            <BenchmarkShareMenu
                                catalog={catalog}
                                chart={chart}
                                isDisabled={chart.points.length === 0}
                                ranked={ranked}
                                run={run}
                                source={source}
                            />
                            <Button size="sm" variant="secondary" onClick={onRunAgain}>
                                <RotateCcw aria-hidden="true" size={12} />
                                {t('benchmark.run.runAgain')}
                            </Button>
                        </>
                    )}
                    <Tooltip content={t('benchmark.run.delete')}>
                        <Button
                            aria-label={t('benchmark.run.delete')}
                            size="icon"
                            variant="ghost"
                            onClick={onDelete}
                        >
                            <Trash2 aria-hidden="true" size={13} />
                        </Button>
                    </Tooltip>
                </div>
            </div>
            <details className="rounded-md border border-border bg-surface px-3 py-2 text-[12px]">
                <summary className="cursor-pointer text-muted select-none">
                    {t('benchmark.run.prompt')}
                </summary>
                <p className="mt-2 mb-0 leading-[1.5] whitespace-pre-wrap">{run.prompt}</p>
            </details>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-3">
                <StatTile
                    label={t('benchmark.run.best')}
                    value={
                        best
                            ? `${modelLabel(catalog, best.entry)}${best.entry.effort ? ` ${best.entry.effort}` : ''}`
                            : undefined
                    }
                    detail={
                        best
                            ? undefined
                            : t(
                                  run.status === 'running'
                                      ? 'benchmark.run.bestPending'
                                      : 'benchmark.run.bestNeedsQuality',
                              )
                    }
                />
                <StatTile
                    label={t('benchmark.run.spent')}
                    value={spend.usd > 0 || !spend.isPartial ? formatUsd(spend.usd) : undefined}
                    detail={t(
                        spend.isPartial ? 'benchmark.run.spentPartial' : 'benchmark.run.spentBasis',
                    )}
                />
                <StatTile
                    label={t('benchmark.run.tokens')}
                    value={tokens ? formatTokens(tokens.total) : undefined}
                    detail={
                        tokens
                            ? `${t('benchmark.run.tokensDetail', {
                                  input: formatTokens(tokens.input),
                                  output: formatTokens(tokens.output),
                                  cacheRead: formatTokens(tokens.cacheRead),
                                  cacheWrite: formatTokens(tokens.cacheWrite),
                              })}${run.judge?.tokens ? ` · ${t('benchmark.run.tokensJudge')}` : ''}`
                            : undefined
                    }
                />
                <StatTile
                    label={t('benchmark.run.wallTime')}
                    value={formatShortDuration(Math.max(0, wallMs)) ?? undefined}
                />
                <StatTile
                    label={t('benchmark.run.completed')}
                    value={`${completed} / ${run.attempts.length}`}
                    detail={
                        run.status === 'cancelled' ? t('benchmark.run.wasCancelled') : undefined
                    }
                />
            </div>
            <ReportCard
                title={t('benchmark.chart.title')}
                caption={
                    run.settings.repeats > 1
                        ? t('benchmark.chart.repeatsCaption', { count: run.settings.repeats })
                        : undefined
                }
            >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <ToggleGroup
                        aria-label={t('benchmark.chart.metric')}
                        value={[xMetric]}
                        onValueChange={(next: BenchmarkMetric[]) => {
                            if (next[0]) setMetric(next[0]);
                        }}
                    >
                        {metrics.map((candidate) => (
                            <ToggleGroupItem key={candidate} value={candidate}>
                                {metricLabel(t, candidate)}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                    {unplottedNames.length > 0 && (
                        <Tooltip content={unplottedNames.join(', ')}>
                            <span className="text-[11px] text-muted">
                                {t('benchmark.chart.unplotted', {
                                    count: unplottedNames.length,
                                    metric: metricLabel(t, xMetric),
                                })}
                            </span>
                        </Tooltip>
                    )}
                </div>
                {chart.points.length > 0 ? (
                    <BenchmarkChart
                        catalog={catalog}
                        chart={chart}
                        highlighted={highlighted}
                        source={source}
                        onHighlight={setHighlighted}
                    />
                ) : (
                    <p className="m-0 py-16 text-center text-[12px] text-muted">
                        {t(
                            run.status === 'running'
                                ? 'benchmark.chart.waiting'
                                : 'benchmark.chart.empty',
                        )}
                    </p>
                )}
                <JudgeNotice run={run} />
            </ReportCard>
            <ReportCard title={t('benchmark.board.title')}>
                <BenchmarkLeaderboard
                    catalog={catalog}
                    highlighted={highlighted}
                    results={ranked}
                    run={run}
                    source={source}
                    onHighlight={setHighlighted}
                />
            </ReportCard>
        </div>
    );
}
