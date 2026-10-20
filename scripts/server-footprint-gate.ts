/**
 * Compares a Server footprint receipt (written by
 * `apps/desktop/src/main/ssh/__tests__/footprint.integration.test.ts`) with the checked-in
 * `scripts/server-footprint-baseline.json`. Every metric is a size in KiB where smaller is better: a value above the
 * baseline plus its group's tolerance fails, a value below it by more than the tolerance passes and asks for a baseline
 * update so the improvement is locked in. See `docs/server-footprint.md`.
 */

export interface FootprintReceipt {
    buildId: string;
    commit: string;
    metrics: Record<string, number>;
    runtime: string;
    runtimeSource: string;
    schemaVersion: 1;
    target: string;
    timings: Record<string, number>;
    version: string;
}

/**
 * Allowed growth for one metric group, the metric name's first segment (`memory`, `load`, `disk`, `transfer`):
 * `baseline * (1 + relative) + absoluteKiB`.
 */
interface FootprintTolerance {
    absoluteKiB: number;
    relative: number;
}

interface FootprintTargetBaseline {
    commit: string;
    metrics: Record<string, number>;
    recordedAt: string;
    runtime: string;
    /**
     * How the cold install obtained Node. `local-upload` streams about 120 MB over SSH, so a receipt recorded the other
     * way is not comparable.
     */
    runtimeSource: string;
}

export interface FootprintBaseline {
    schemaVersion: 1;
    targets: Partial<Record<string, FootprintTargetBaseline>>;
    tolerances: Partial<Record<string, FootprintTolerance>>;
}

type FootprintVerdict = 'improved' | 'missing' | 'new' | 'pass' | 'regressed';

interface FootprintRow {
    baseline?: number;
    current?: number;
    limit?: number;
    metric: string;
    verdict: FootprintVerdict;
}

export interface FootprintComparison {
    /**
     * Why the receipt could not be compared at all (no baseline for its target, a different runtime source).
     */
    blocker?: string;
    isFailed: boolean;
    rows: FootprintRow[];
}

function metricGroup(metric: string): string {
    return metric.split('.', 1)[0] ?? metric;
}

export function compareFootprint(
    receipt: FootprintReceipt,
    baseline: FootprintBaseline,
): FootprintComparison {
    const target = baseline.targets[receipt.target];
    if (!target)
        return {
            blocker: `No baseline for ${receipt.target}; record one with --update`,
            isFailed: true,
            rows: [],
        };
    if (target.runtimeSource !== receipt.runtimeSource)
        return {
            blocker: `Runtime source ${receipt.runtimeSource} differs from the baseline's ${target.runtimeSource}`,
            isFailed: true,
            rows: [],
        };
    const rows: FootprintRow[] = [];
    for (const [metric, value] of Object.entries(target.metrics)) {
        const current = Object.hasOwn(receipt.metrics, metric)
            ? receipt.metrics[metric]
            : undefined;
        const tolerance = baseline.tolerances[metricGroup(metric)];
        if (current === undefined) {
            rows.push({ metric, baseline: value, verdict: 'missing' });
            continue;
        }
        if (!tolerance) throw new Error(`No tolerance for metric group ${metricGroup(metric)}`);
        const margin = value * tolerance.relative + tolerance.absoluteKiB;
        const limit = Math.round(value + margin);
        let verdict: FootprintVerdict = 'pass';
        if (current > limit) verdict = 'regressed';
        else if (current < value - margin) verdict = 'improved';
        rows.push({ metric, baseline: value, current, limit, verdict });
    }
    for (const [metric, current] of Object.entries(receipt.metrics))
        if (!(metric in target.metrics)) rows.push({ metric, current, verdict: 'new' });
    return {
        isFailed: rows.some((row) => row.verdict === 'regressed' || row.verdict === 'missing'),
        rows,
    };
}

/**
 * Replaces the receipt target's entry with the receipt's metrics; other targets and the tolerances stay.
 */
export function updateFootprintBaseline(
    baseline: FootprintBaseline,
    receipt: FootprintReceipt,
    recordedAt: string,
): FootprintBaseline {
    return {
        ...baseline,
        targets: {
            ...baseline.targets,
            [receipt.target]: {
                commit: receipt.commit,
                metrics: receipt.metrics,
                recordedAt,
                runtime: receipt.runtime,
                runtimeSource: receipt.runtimeSource,
            },
        },
    };
}

function formatMiB(kib: number | undefined): string {
    return kib === undefined ? '-' : `${(kib / 1024).toFixed(1)} MiB`;
}

export function formatFootprintTable(comparison: FootprintComparison): string {
    if (comparison.blocker) return comparison.blocker;
    const header = ['metric', 'baseline', 'current', 'limit', 'verdict'];
    const lines = comparison.rows.map((row) => [
        row.metric,
        formatMiB(row.baseline),
        formatMiB(row.current),
        formatMiB(row.limit),
        row.verdict,
    ]);
    const widths = header.map((title, column) =>
        Math.max(title.length, ...lines.map((line) => line[column]?.length ?? 0)),
    );
    const render = (cells: string[]): string =>
        cells
            .map((cell, column) => cell.padEnd(widths[column] ?? 0))
            .join('  ')
            .trimEnd();
    return [render(header), ...lines.map(render)].join('\n');
}
