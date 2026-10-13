import type {
    BenchmarkAttempt,
    BenchmarkEntry,
    BenchmarkRun,
    UsageTokenBreakdown,
} from '@caxri/protocol';

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
     * Median time to first token of the completed Attempts.
     */
    timeToFirstTokenMs?: number;
    /**
     * Output tokens per second of model generation over the completed Attempts, present only when every one of them was
     * measured.
     */
    tokensPerSecond?: number;
    /**
     * Share (0 to 1) of input tokens served from the prompt cache over the completed Attempts.
     */
    cacheHitRate?: number;
    /**
     * The fullest context any completed Attempt reached, with its share of the window the Agent compacts against.
     */
    peakContext?: { tokens: number; ratio?: number };
    /**
     * Mean compactions per completed Attempt.
     */
    compactions?: number;
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

export type BenchmarkMetric =
    | 'cost'
    | 'time'
    | 'outputTokens'
    | 'steps'
    | 'timeToFirstToken'
    | 'tokensPerSecond'
    | 'cacheHitRate';

const BENCHMARK_METRICS: readonly BenchmarkMetric[] = [
    'cost',
    'time',
    'outputTokens',
    'steps',
    'timeToFirstToken',
    'tokensPerSecond',
    'cacheHitRate',
];

/**
 * Metrics where more is better. The chart runs their axis low to high, and every other one high to low, so the best
 * point always sits on the right.
 */
export function isHigherBetter(metric: BenchmarkMetric): boolean {
    return metric === 'tokensPerSecond' || metric === 'cacheHitRate';
}

/**
 * Share of input tokens read from the prompt cache. Cache writes count as uncached input: they were billed as new.
 */
export function cacheHitRate(tokens: UsageTokenBreakdown): number | undefined {
    const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    return input > 0 ? tokens.cacheRead / input : undefined;
}

/**
 * Output tokens per second while the model generated, or `undefined` when the Agent's transcript has no timing.
 */
export function tokensPerSecond(attempt: BenchmarkAttempt): number | undefined {
    const generation = attempt.generation;
    return generation ? generation.outputTokens / (generation.durationMs / 1_000) : undefined;
}

/**
 * The context an Attempt reached against the window the Agent compacts at, which is when pressure starts to matter.
 */
export function contextRatio(
    context: NonNullable<BenchmarkAttempt['context']>,
    tokens = context.peakTokens,
): number | undefined {
    const window = context.compactWindow ?? context.window;
    return window ? tokens / window : undefined;
}

/**
 * Every token of an Attempt and the judge summed field by field, for the run's total.
 */
export function runTokens(run: BenchmarkRun): UsageTokenBreakdown | undefined {
    return sumTokens([...run.attempts.map((attempt) => attempt.tokens), run.judge?.tokens]);
}

function sumTokens(
    breakdowns: ReadonlyArray<UsageTokenBreakdown | undefined>,
): UsageTokenBreakdown | undefined {
    const parts = breakdowns.filter((tokens) => tokens !== undefined);
    if (parts.length === 0) return undefined;
    const total: UsageTokenBreakdown = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
    };
    for (const tokens of parts)
        for (const key of Object.keys(total) as Array<keyof UsageTokenBreakdown>)
            total[key] += tokens[key];
    return total;
}

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
            Object.assign(result, performanceOf(completed));
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
 * Speed, cache, and context figures of an Entry's completed Attempts. Rates are pooled (summed tokens over summed time)
 * rather than averaged, so a short Attempt does not weigh as much as a long one.
 */
function performanceOf(
    completed: readonly BenchmarkAttempt[],
): Pick<
    ConfigResult,
    'cacheHitRate' | 'compactions' | 'peakContext' | 'timeToFirstTokenMs' | 'tokensPerSecond'
> {
    const result: ReturnType<typeof performanceOf> = {};
    const firstTokens = completed.flatMap((attempt) =>
        attempt.timeToFirstTokenMs === undefined ? [] : [attempt.timeToFirstTokenMs],
    );
    const timeToFirstTokenMs = median(firstTokens);
    if (timeToFirstTokenMs !== undefined) result.timeToFirstTokenMs = timeToFirstTokenMs;
    if (completed.every((attempt) => attempt.generation)) {
        const outputTokens = completed.reduce(
            (sum, a) => sum + (a.generation?.outputTokens ?? 0),
            0,
        );
        const durationMs = completed.reduce((sum, a) => sum + (a.generation?.durationMs ?? 0), 0);
        if (durationMs > 0) result.tokensPerSecond = outputTokens / (durationMs / 1_000);
    }
    if (completed.every((attempt) => attempt.tokens)) {
        const pooled = sumTokens(completed.map((attempt) => attempt.tokens));
        const rate = pooled && cacheHitRate(pooled);
        if (rate !== undefined) result.cacheHitRate = rate;
    }
    const peak = completed
        .map((attempt) => attempt.context)
        .filter((context) => context !== undefined)
        .reduce<NonNullable<BenchmarkAttempt['context']> | undefined>(
            (fullest, context) =>
                !fullest || context.peakTokens > fullest.peakTokens ? context : fullest,
            undefined,
        );
    if (peak) {
        const ratio = contextRatio(peak);
        result.peakContext = { tokens: peak.peakTokens, ...(ratio !== undefined && { ratio }) };
    }
    const compactions = completed.flatMap((attempt) =>
        attempt.compactions === undefined ? [] : [attempt.compactions],
    );
    const meanCompactions = mean(compactions);
    if (meanCompactions !== undefined) result.compactions = meanCompactions;
    return result;
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
        case 'timeToFirstToken': {
            return result.timeToFirstTokenMs;
        }
        case 'tokensPerSecond': {
            return result.tokensPerSecond;
        }
        case 'cacheHitRate': {
            return result.cacheHitRate === undefined ? undefined : result.cacheHitRate * 100;
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
     * Positive when `left` is better: on the vertical axis higher quality, or lower time; on the horizontal axis the
     * metric's own direction.
     */
    const yBetter = (left: number, right: number) =>
        y === 'quality' ? left - right : right - left;
    const xBetter = (left: number, right: number) =>
        isHigherBetter(x) ? left - right : right - left;
    for (const point of points)
        point.isFrontier = points.every(
            (other) =>
                !(
                    other !== point &&
                    xBetter(other.x, point.x) >= 0 &&
                    yBetter(other.y, point.y) >= 0 &&
                    (xBetter(other.x, point.x) > 0 || yBetter(other.y, point.y) > 0)
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
