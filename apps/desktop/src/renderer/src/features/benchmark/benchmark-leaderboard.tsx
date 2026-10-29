import { Fragment, useState } from 'react';

import type { BenchmarkCatalog, BenchmarkRun } from '@caxri/protocol';
import { formatShortDuration, formatTokens, formatUsd } from '@caxri/protocol';
import { ChevronRight } from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import {
    cellClass,
    numericCellClass,
    numericHeadClass,
    tableHeadClass,
} from '../../components/report-table-classes';
import { Spinner } from '../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from '../../components/ui/tooltip';
import { useContainerWidth } from '../../hooks/use-container-width';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { BenchmarkAttemptDetail } from './benchmark-attempt-detail';
import {
    attemptStatusLabel,
    formatLatency,
    formatPercent,
    markerShape,
    modelLabel,
    seriesColor,
} from './benchmark-presentation';
import { useTickingNow } from './benchmark-queries';
import type { ConfigResult, QualitySource } from './benchmark-results';
import { isAttemptFinished } from './benchmark-results';

function Dash() {
    return <span className="text-muted">–</span>;
}

/**
 * The legend swatch beside a model name: the same hue and shape its chart point uses.
 */
function SeriesSwatch({ result }: { result: ConfigResult }) {
    const shape = markerShape(result.entry.provider);
    return (
        <span
            aria-hidden="true"
            className={cn(
                'inline-block size-2 flex-none',
                shape === 'circle' && 'rounded-full',
                shape === 'diamond' && 'scale-[0.85] rotate-45',
            )}
            style={{ background: seriesColor(result.entry.provider) }}
        />
    );
}

function statusText(t: Translate, result: ConfigResult, now: number): React.ReactNode {
    const running = result.attempts.find((attempt) => !isAttemptFinished(attempt));
    if (running) {
        const elapsed = running.startedAt
            ? formatShortDuration(now - running.startedAt)
            : undefined;
        return (
            <span className="inline-flex items-center gap-1.5 text-muted">
                <Spinner aria-hidden="true" className="size-3" />
                {t(`benchmark.status.${running.status}`)}
                {running.status === 'running' && (
                    <span className="tabular-nums">
                        {elapsed ? ` · ${elapsed}` : ''}
                        {running.steps > 0
                            ? ` · ${t('benchmark.board.steps', { count: running.steps })}`
                            : ''}
                    </span>
                )}
            </span>
        );
    }
    if (result.attempts.length === 1) {
        const [attempt] = result.attempts;
        return (
            <span
                className={
                    attempt.status === 'completed'
                        ? 'text-foreground'
                        : attempt.status === 'cancelled'
                          ? 'text-muted'
                          : 'text-danger'
                }
            >
                {attemptStatusLabel(t, attempt)}
            </span>
        );
    }
    const failed = result.finished - result.completed;
    return (
        <span className={failed > 0 ? 'text-danger' : 'text-foreground'}>
            {t('benchmark.board.completedOf', {
                completed: result.completed,
                total: result.attempts.length,
            })}
        </span>
    );
}

function qualityCell(
    t: Translate,
    result: ConfigResult,
    source: QualitySource,
    repeats: number,
): React.ReactNode {
    if (source === 'judge')
        return result.score === undefined ? (
            <Dash />
        ) : (
            <span className="font-semibold">{Math.round(result.score)}</span>
        );
    if (source === 'check') {
        if (result.checkPassRate === undefined) return <Dash />;
        if (repeats === 1)
            return result.checkPassRate === 1 ? (
                <span className="text-diff-stat-added">{t('benchmark.board.passed')}</span>
            ) : (
                <span className="text-danger">{t('benchmark.board.failed')}</span>
            );
        return `${Math.round(result.checkPassRate * 100)}%`;
    }
    return null;
}

/**
 * Below this board width, tokens, steps, and changes give their room to the model name; the expanded row repeats them.
 */
const WIDE_BOARD_MIN_WIDTH = 768;
/**
 * From this width the board also shows first-token latency, cache hits, and peak context.
 */
const WIDEST_BOARD_MIN_WIDTH = 1_024;

function PerformanceCells({ result }: { result: ConfigResult }) {
    const { peakContext } = result;
    return (
        <>
            <td className={numericCellClass}>
                {result.timeToFirstTokenMs === undefined ? (
                    <Dash />
                ) : (
                    formatLatency(result.timeToFirstTokenMs)
                )}
            </td>
            <td className={numericCellClass}>
                {result.cacheHitRate === undefined ? <Dash /> : formatPercent(result.cacheHitRate)}
            </td>
            <td className={numericCellClass}>
                {peakContext ? (
                    <Tooltip content={formatTokens(peakContext.tokens)}>
                        <span className={FOCUSABLE_TOOLTIP_TRIGGER_CLASS} tabIndex={0}>
                            {peakContext.ratio === undefined
                                ? formatTokens(peakContext.tokens)
                                : formatPercent(peakContext.ratio)}
                        </span>
                    </Tooltip>
                ) : (
                    <Dash />
                )}
            </td>
        </>
    );
}

/**
 * The ranked table under the chart, the same rows from the first queued Attempt to the last result. A row opens to its
 * Attempts, each showing what it left behind.
 */
export function BenchmarkLeaderboard({
    run,
    results,
    source,
    catalog,
    highlighted,
    onHighlight,
}: {
    run: BenchmarkRun;
    results: ConfigResult[];
    source: QualitySource;
    catalog: BenchmarkCatalog | undefined;
    highlighted: number | undefined;
    onHighlight: (entryIndex: number | undefined) => void;
}) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState<number | undefined>();
    const [selectedAttempt, setSelectedAttempt] = useState<Record<number, string>>({});
    const now = useTickingNow(run.status === 'running');
    const { repeats } = run.settings;
    const hasQuality = source !== 'none';
    const [boardReference, boardWidth] = useContainerWidth<HTMLDivElement>();
    const isWide = boardWidth >= WIDE_BOARD_MIN_WIDTH;
    const isWidest = boardWidth >= WIDEST_BOARD_MIN_WIDTH;
    // The expanded row spans exactly the rendered columns: extra span would add empty fixed-layout columns.
    const columns = 5 + Number(hasQuality) + (isWide ? 3 : 0) + (isWidest ? 3 : 0);
    const figureWidth = isWide ? 'w-20' : 'w-16';
    return (
        <div ref={boardReference}>
            <table className="w-full table-fixed border-collapse" data-benchmark-leaderboard>
                <thead>
                    <tr>
                        <th className={cn(tableHeadClass, 'w-8')}>
                            <span className="sr-only">{t('benchmark.board.rank')}</span>
                        </th>
                        <th className={tableHeadClass}>{t('benchmark.board.model')}</th>
                        {hasQuality && (
                            <th className={cn(numericHeadClass, figureWidth)}>
                                {t(
                                    source === 'judge'
                                        ? 'benchmark.board.score'
                                        : 'benchmark.board.check',
                                )}
                            </th>
                        )}
                        <th className={cn(numericHeadClass, figureWidth)}>
                            {t('benchmark.metric.time')}
                        </th>
                        <th className={cn(numericHeadClass, figureWidth)}>
                            {t('benchmark.metric.cost')}
                        </th>
                        {isWide && (
                            <th className={cn(numericHeadClass, 'w-24')}>
                                {t('benchmark.board.tokens')}
                            </th>
                        )}
                        {isWide && (
                            <th className={cn(numericHeadClass, 'w-16')}>
                                {t('benchmark.metric.steps')}
                            </th>
                        )}
                        {isWide && (
                            <th className={cn(numericHeadClass, 'w-24')}>
                                {t('benchmark.board.changes')}
                            </th>
                        )}
                        {isWidest && (
                            <>
                                <Tooltip content={t('benchmark.board.firstTokenHint')}>
                                    <th
                                        className={cn(
                                            numericHeadClass,
                                            'w-20',
                                            FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                                        )}
                                        tabIndex={0}
                                    >
                                        {t('benchmark.board.firstToken')}
                                    </th>
                                </Tooltip>
                                <Tooltip content={t('benchmark.board.cacheHint')}>
                                    <th
                                        className={cn(
                                            numericHeadClass,
                                            'w-20',
                                            FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                                        )}
                                        tabIndex={0}
                                    >
                                        {t('benchmark.board.cache')}
                                    </th>
                                </Tooltip>
                                <Tooltip content={t('benchmark.board.contextHint')}>
                                    <th
                                        className={cn(
                                            numericHeadClass,
                                            'w-20',
                                            FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                                        )}
                                        tabIndex={0}
                                    >
                                        {t('benchmark.board.context')}
                                    </th>
                                </Tooltip>
                            </>
                        )}
                        <th className={cn(tableHeadClass, 'pl-3', isWide ? 'w-40' : 'w-28')}>
                            {t('benchmark.board.status')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {results.map((result, index) => {
                        const isExpanded = expanded === result.entryIndex;
                        const attemptId =
                            selectedAttempt[result.entryIndex] ?? result.attempts[0]?.id;
                        const attempt =
                            result.attempts.find((candidate) => candidate.id === attemptId) ??
                            result.attempts[0];
                        const diff =
                            result.attempts.length === 1 ? result.attempts[0].diff : undefined;
                        const name = modelLabel(catalog, result.entry);
                        return (
                            <Fragment key={result.entryIndex}>
                                <tr
                                    aria-expanded={isExpanded}
                                    className={cn(
                                        'cursor-pointer border-t border-border hover:bg-list-hover-background',
                                        highlighted === result.entryIndex &&
                                            'bg-list-hover-background',
                                    )}
                                    data-benchmark-row={result.entryIndex}
                                    tabIndex={0}
                                    onClick={() =>
                                        setExpanded(isExpanded ? undefined : result.entryIndex)
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key !== 'Enter' && event.key !== ' ') return;
                                        event.preventDefault();
                                        setExpanded(isExpanded ? undefined : result.entryIndex);
                                    }}
                                    onPointerEnter={() => onHighlight(result.entryIndex)}
                                    onPointerLeave={() => onHighlight(undefined)}
                                >
                                    <td className={cn(cellClass, 'text-muted tabular-nums')}>
                                        {!hasQuality || result.isRunning ? '' : index + 1}
                                    </td>
                                    <td className={cellClass}>
                                        <span className="flex min-w-0 items-center gap-2">
                                            <ChevronRight
                                                aria-hidden="true"
                                                className={cn(
                                                    'flex-none text-muted transition-transform',
                                                    isExpanded && 'rotate-90',
                                                )}
                                                size={12}
                                            />
                                            <AgentIdentityIcon
                                                identity={result.entry.provider}
                                                size={14}
                                            />
                                            <Tooltip content={result.entry.model}>
                                                <span
                                                    className={cn(
                                                        'truncate',
                                                        FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                                                    )}
                                                    tabIndex={0}
                                                >
                                                    {name}
                                                </span>
                                            </Tooltip>
                                            <span className="flex-none text-[11px] tracking-[0.06em] text-muted uppercase">
                                                {result.entry.effort ??
                                                    t('benchmark.picker.defaultEffort')}
                                            </span>
                                            <SeriesSwatch result={result} />
                                        </span>
                                    </td>
                                    {hasQuality && (
                                        <td className={numericCellClass}>
                                            {qualityCell(t, result, source, repeats)}
                                        </td>
                                    )}
                                    <td className={numericCellClass}>
                                        {result.durationMs === undefined ? (
                                            <Dash />
                                        ) : (
                                            formatShortDuration(result.durationMs)
                                        )}
                                    </td>
                                    <td className={numericCellClass}>
                                        {result.costUsd === undefined ? (
                                            result.completed > 0 ? (
                                                <Tooltip
                                                    content={t('benchmark.board.costUnknownHint')}
                                                >
                                                    <span
                                                        className={cn(
                                                            'text-muted',
                                                            FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                                                        )}
                                                        tabIndex={0}
                                                    >
                                                        {t('benchmark.board.costUnknown')}
                                                    </span>
                                                </Tooltip>
                                            ) : (
                                                <Dash />
                                            )
                                        ) : (
                                            formatUsd(result.costUsd)
                                        )}
                                    </td>
                                    {isWide && (
                                        <>
                                            <td className={numericCellClass}>
                                                {result.totalTokens === undefined ? (
                                                    <Dash />
                                                ) : (
                                                    <Tooltip
                                                        content={t('benchmark.board.tokensHint')}
                                                    >
                                                        <span
                                                            className={
                                                                FOCUSABLE_TOOLTIP_TRIGGER_CLASS
                                                            }
                                                            tabIndex={0}
                                                        >
                                                            {formatTokens(result.totalTokens)}
                                                            <span className="text-muted">
                                                                {' / '}
                                                                {formatTokens(
                                                                    result.outputTokens ?? 0,
                                                                )}
                                                            </span>
                                                        </span>
                                                    </Tooltip>
                                                )}
                                            </td>
                                            <td className={numericCellClass}>
                                                {result.steps === undefined ? (
                                                    <Dash />
                                                ) : (
                                                    Math.round(result.steps * 10) / 10
                                                )}
                                            </td>
                                            <td className={numericCellClass}>
                                                {diff ? (
                                                    diff.files === 0 ? (
                                                        <span className="text-muted">
                                                            {t('benchmark.board.noChanges')}
                                                        </span>
                                                    ) : (
                                                        <span className="inline-flex justify-end">
                                                            <DiffStat
                                                                additions={diff.additions}
                                                                deletions={diff.deletions}
                                                            />
                                                        </span>
                                                    )
                                                ) : (
                                                    <Dash />
                                                )}
                                            </td>
                                        </>
                                    )}
                                    {isWidest && <PerformanceCells result={result} />}
                                    <td className={cn(cellClass, 'pl-3')}>
                                        {statusText(t, result, now)}
                                    </td>
                                </tr>
                                {isExpanded && (
                                    <tr>
                                        <td
                                            className="border-t border-border bg-background/40 px-3 py-3"
                                            colSpan={columns}
                                        >
                                            {result.attempts.length > 1 && (
                                                <ToggleGroup
                                                    aria-label={t('benchmark.board.attempts')}
                                                    className="mb-3"
                                                    value={[attempt.id]}
                                                    onValueChange={(next: string[]) => {
                                                        const [id] = next;
                                                        if (id)
                                                            setSelectedAttempt((current) => ({
                                                                ...current,
                                                                [result.entryIndex]: id,
                                                            }));
                                                    }}
                                                >
                                                    {result.attempts.map((candidate) => (
                                                        <ToggleGroupItem
                                                            key={candidate.id}
                                                            value={candidate.id}
                                                        >
                                                            {t('benchmark.board.attempt', {
                                                                repeat: candidate.repeat,
                                                            })}
                                                        </ToggleGroupItem>
                                                    ))}
                                                </ToggleGroup>
                                            )}
                                            <BenchmarkAttemptDetail
                                                attempt={attempt}
                                                runId={run.id}
                                            />
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
