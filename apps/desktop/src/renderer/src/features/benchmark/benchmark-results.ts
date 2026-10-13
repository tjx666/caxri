import type { BenchmarkAttempt, BenchmarkEntry, BenchmarkRun } from '@caxri/protocol';

/**
 * What one Entry (an Agent, model, and effort) achieved across its repeats.
 */
export interface ConfigResult {
    entryIndex: number;
    entry: BenchmarkEntry;
    attempts: BenchmarkAttempt[];
    /**
     * Attempts that reached a final state, and those among them that completed their turn.
     */
    finished: number;
    completed: number;
    /**
     * Median wall time of the completed Attempts.
     */
    durationMs?: number;
    /**
     * Mean cost of the completed Attempts, present only when every one of them was priced: an average over the priced
     * half would read as the whole.
     */
    costUsd?: number;
    outputTokens?: number;
    totalTokens?: number;
    steps?: number;
    /**
     * Mean judge score (0 to 100) of the completed Attempts the judge scored.
     */
    score?: number;
    /**
     * Share (0 to 1) of the Attempts with a check result whose check passed.
     */
    checkPassRate?: number;
    isRunning: boolean;
}

/**
 * Where the chart's quality axis comes from: the blind judge's scores, the check command's pass rate, or nothing, in
 * which case the chart plots time against the chosen metric instead.
 */
export type QualitySource = 'judge' | 'check' | 'none';

export type BenchmarkMetric = 'cost' | 'time' | 'outputTokens' | 'steps';

const BENCHMARK_METRICS: readonly BenchmarkMetric[] = ['cost', 'time', 'outputTokens', 'steps'];

const FINAL_STATUSES = new Set<BenchmarkAttempt['status']>([
    'completed',
    'failed',
    'timedOut',
    'cancelled',
]);

export function isAttemptFinished(attempt: BenchmarkAttempt): boolean {
    return FINAL_STATUSES.has(attempt.status);
}

/**
 * Efforts from least to most thinking, so one model's points join in the order a reader expects.
 */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function effortRank(effort: string | undefined): number {
    const index = effort ? EFFORT_ORDER.indexOf(effort) : -1;
    return index === -1 ? EFFORT_ORDER.length : index;
}

function mean(values: readonly number[]): number | undefined {
    return values.length === 0
        ? undefined
        : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = values.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The mean of `pick` over every Attempt, or `undefined` as soon as one of them has no value.
 */
function meanOfAll(
    attempts: readonly BenchmarkAttempt[],
    pick: (attempt: BenchmarkAttempt) => number | undefined,
): number | undefined {
    const values = attempts.map(pick);
    return values.every((value): value is number => value !== undefined) ? mean(values) : undefined;
}

export function configResults(run: BenchmarkRun): ConfigResult[] {
    return run.entries.map((entry, entryIndex) => {
        const attempts = run.attempts.filter((attempt) => attempt.entryIndex === entryIndex);
        const completed = attempts.filter((attempt) => attempt.status === 'completed');
        const checked = attempts.filter((attempt) => attempt.check);
        const durations = completed.flatMap((attempt) =>
            attempt.durationMs === undefined ? [] : [attempt.durationMs],
        );
        const scores = completed.flatMap((attempt) => (attempt.judge ? [attempt.judge.score] : []));
        const result: ConfigResult = {
            entryIndex,
            entry,
            attempts,
            finished: attempts.filter(isAttemptFinished).length,
            completed: completed.length,
            isRunning: attempts.some((attempt) => !isAttemptFinished(attempt)),
        };
        const durationMs = median(durations);
        if (durationMs !== undefined) result.durationMs = durationMs;
        if (completed.length > 0) {
            const costUsd = meanOfAll(completed, (attempt) => attempt.costUsd);
            if (costUsd !== undefined) result.costUsd = costUsd;
            const outputTokens = meanOfAll(completed, (attempt) => attempt.tokens?.output);
            if (outputTokens !== undefined) result.outputTokens = outputTokens;
            const totalTokens = meanOfAll(completed, (attempt) => attempt.tokens?.total);
            if (totalTokens !== undefined) result.totalTokens = totalTokens;
            result.steps = mean(completed.map((attempt) => attempt.steps));
        }
        const score = mean(scores);
        if (score !== undefined) result.score = score;
        if (checked.length > 0)
            result.checkPassRate =
                checked.filter((attempt) => attempt.check?.status === 'passed').length /
                checked.length;
        return result;
    });
}

/**
 * What the run has spent so far: every priced Attempt, failed ones included, plus the judge. `isPartial` says some of
 * it could not be priced, so the figure is a floor.
 */
export function runSpend(run: BenchmarkRun): { usd: number; isPartial: boolean } {
    let usd = run.judge?.costUsd ?? 0;
    let isPartial = run.judge?.status === 'completed' && run.judge.costUsd === undefined;
    for (const attempt of run.attempts) {
        if (attempt.costUsd !== undefined) usd += attempt.costUsd;
        else if (attempt.status !== 'cancelled' && attempt.status !== 'queued') isPartial = true;
    }
    return { usd, isPartial };
}

export function qualitySource(run: BenchmarkRun, results: readonly ConfigResult[]): QualitySource {
    if (results.some((result) => result.score !== undefined)) return 'judge';
    if (run.settings.checkCommand) return 'check';
    return 'none';
}

/**
 * Quality on a 0 to 100 scale, or `undefined` when the source has nothing for this Entry.
 */
function qualityOf(result: ConfigResult, source: QualitySource): number | undefined {
    if (source === 'judge') return result.score;
    if (source === 'check' && result.checkPassRate !== undefined) return result.checkPassRate * 100;
    return undefined;
}

function metricOf(result: ConfigResult, metric: BenchmarkMetric): number | undefined {
    switch (metric) {
        case 'cost': {
            return result.costUsd;
        }
        case 'time': {
            return result.durationMs;
        }
        case 'outputTokens': {
            return result.outputTokens;
        }
        case 'steps': {
            return result.completed > 0 ? result.steps : undefined;
        }
    }
}

/**
 * The leaderboard order: best quality first, then the most reliable, then the cheapest and fastest. Entries still
 * running keep their place at the end so a finished row never jumps under the pointer.
 */
export function rankResults(
    results: readonly ConfigResult[],
    source: QualitySource,
): ConfigResult[] {
    const compareOptional = (
        left: number | undefined,
        right: number | undefined,
        isHigherBetter: boolean,
    ) => {
        if (left === undefined && right === undefined) return 0;
        if (left === undefined) return 1;
        if (right === undefined) return -1;
        return isHigherBetter ? right - left : left - right;
    };
    return results.toSorted(
        (left, right) =>
            Number(left.isRunning) - Number(right.isRunning) ||
            compareOptional(qualityOf(left, source), qualityOf(right, source), true) ||
            compareOptional(
                left.finished > 0 ? left.completed / left.finished : undefined,
                right.finished > 0 ? right.completed / right.finished : undefined,
                true,
            ) ||
            compareOptional(left.costUsd, right.costUsd, false) ||
            compareOptional(left.durationMs, right.durationMs, false) ||
            left.entryIndex - right.entryIndex,
    );
}

export interface ChartPoint {
    entryIndex: number;
    entry: BenchmarkEntry;
    x: number;
    y: number;
    /**
     * No other point is at least as good on both axes and better on one: the efficient frontier.
     */
    isFrontier: boolean;
}

interface ChartSeries {
    key: string;
    entry: BenchmarkEntry;
    points: ChartPoint[];
}

export interface ChartModel {
    /**
     * What the vertical axis shows: quality when the run has a quality signal, otherwise time.
     */
    y: 'quality' | 'time';
    x: BenchmarkMetric;
    points: ChartPoint[];
    /**
     * One line per model with more than one plotted effort, joined from least to most effort.
     */
    series: ChartSeries[];
    /**
     * Finished Entries the chosen metric could not place, such as an Entry with unknown cost on the Cost tab.
     */
    unplotted: number;
}

/**
 * The metrics a chart can put on the horizontal axis: every metric except the one already on the vertical axis.
 */
export function chartMetrics(source: QualitySource): BenchmarkMetric[] {
    return source === 'none'
        ? BENCHMARK_METRICS.filter((metric) => metric !== 'time')
        : [...BENCHMARK_METRICS];
}

export function buildChart(
    results: readonly ConfigResult[],
    source: QualitySource,
    x: BenchmarkMetric,
): ChartModel {
    const y = source === 'none' ? 'time' : 'quality';
    const finished = results.filter((result) => result.completed > 0);
    const points: ChartPoint[] = [];
    for (const result of finished) {
        const xValue = metricOf(result, x);
        const yValue = y === 'quality' ? qualityOf(result, source) : result.durationMs;
        if (xValue === undefined || yValue === undefined) continue;
        points.push({
            entryIndex: result.entryIndex,
            entry: result.entry,
            x: xValue,
            y: yValue,
            isFrontier: false,
        });
    }
    /**
     * Lower is better on every horizontal metric; on the vertical axis higher quality, or lower time, is better.
     */
    const yBetter = (left: number, right: number) =>
        y === 'quality' ? left - right : right - left;
    for (const point of points)
        point.isFrontier = points.every(
            (other) =>
                !(
                    other !== point &&
                    other.x <= point.x &&
                    yBetter(other.y, point.y) >= 0 &&
                    (other.x < point.x || yBetter(other.y, point.y) > 0)
                ),
        );
    const groups = new Map<string, ChartPoint[]>();
    for (const point of points) {
        const key = `${point.entry.provider}\u{0}${point.entry.model}`;
        groups.set(key, [...(groups.get(key) ?? []), point]);
    }
    const series = [...groups]
        .filter(([, group]) => group.length > 1)
        .map(([key, group]) => ({
            key,
            entry: group[0].entry,
            points: group.toSorted(
                (left, right) => effortRank(left.entry.effort) - effortRank(right.entry.effort),
            ),
        }));
    return { y, x, points, series, unplotted: finished.length - points.length };
}

/**
 * Evenly spaced round tick values covering `[min, max]`, and the padded domain they span.
 */
export function niceScale(
    min: number,
    max: number,
    tickCount = 5,
): { domain: [number, number]; ticks: number[] } {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { domain: [0, 1], ticks: [0, 1] };
    let low = min;
    let high = max;
    if (high - low < Number.EPSILON) {
        const pad = Math.abs(high) > 0 ? Math.abs(high) * 0.1 : 1;
        low -= pad;
        high += pad;
    }
    const rawStep = (high - low) / Math.max(1, tickCount - 1);
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step =
        ([1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= rawStep) ?? 10) * magnitude;
    const start = Math.floor(low / step) * step;
    const end = Math.ceil(high / step) * step;
    const ticks: number[] = [];
    for (let value = start; value <= end + step / 2; value += step)
        ticks.push(Number(value.toPrecision(12)));
    return { domain: [start, end], ticks };
}
