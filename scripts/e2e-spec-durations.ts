import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Measured E2E cost that the pool partition in `e2e-pool-shard.ts` balances by.
 *
 * `specs` maps a spec path to the seconds its tests took, summed over every `test-end` event of the measured runs and
 * rounded to whole seconds (never below one). `medianTestSeconds` is the median single-test duration, which prices a
 * spec the table does not know yet (declared test count times this median).
 *
 * Failing tests spend their full timeouts, so some entries are inflated until those failures are fixed (#3351). The
 * table is a balancing hint, not a performance baseline: regenerate it from a fresh hosted-full run whenever the shards
 * drift apart.
 */
export interface E2ESpecDurationTable {
    medianTestSeconds: number;
    specs: Partial<Record<string, number>>;
}

/**
 * Repository-relative location of the committed table.
 */
export const E2E_SPEC_DURATIONS_PATH = 'scripts/e2e-spec-durations.json';

/**
 * Jobs whose logs hold `test-end` events that are not pool specs (performance gates report other statuses).
 */
const DEFAULT_SKIPPED_JOBS = ['e2e-perf'];

const TEST_END =
    /^(?:(?<job>[^\t]*)\t)?.*?CAXRI_E2E_PUBLIC (?<payload>\{.*"event":"test-end".*\})\s*$/u;

export interface SpecDurationSamples {
    /**
     * Milliseconds per test, in log order, for the median.
     */
    tests: number[];
    /**
     * Total milliseconds per spec path.
     */
    specs: Map<string, number>;
}

/**
 * Collects `test-end` durations from downloaded hosted job logs (`gh run view --log` output, whose first tab-separated
 * column is the job name). Lines of a skipped job and lines whose location is not an `e2e/*.e2e.ts` spec are ignored.
 */
export function collectSpecDurations(
    logs: readonly string[],
    skippedJobs: readonly string[] = DEFAULT_SKIPPED_JOBS,
): SpecDurationSamples {
    const samples: SpecDurationSamples = { specs: new Map(), tests: [] };
    const lines = logs.flatMap((log) => log.split('\n'));
    for (const line of lines) {
        const match = TEST_END.exec(line);
        if (!match?.groups) continue;
        const job = String(match.groups.job);
        if (skippedJobs.some((skipped) => job === skipped || job.startsWith(`${skipped} `))) {
            continue;
        }
        let event: { durationMs?: unknown; location?: unknown };
        try {
            event = JSON.parse(match.groups.payload) as typeof event;
        } catch {
            continue;
        }
        const spec = /^(e2e\/[^:]+\.e2e\.ts):/u.exec(String(event.location))?.[1];
        if (!spec || typeof event.durationMs !== 'number') continue;
        samples.tests.push(event.durationMs);
        samples.specs.set(spec, (samples.specs.get(spec) ?? 0) + event.durationMs);
    }
    return samples;
}

/**
 * Builds the committed table: specs sorted by path, seconds rounded, median of single tests to one decimal.
 */
export function buildSpecDurationTable(samples: SpecDurationSamples): E2ESpecDurationTable {
    const sorted = samples.tests.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median =
        sorted.length === 0
            ? 1
            : sorted.length % 2 === 1
              ? sorted[middle]
              : (sorted[middle - 1] + sorted[middle]) / 2;
    return {
        medianTestSeconds: Math.max(0.1, Math.round(median / 100) / 10),
        specs: Object.fromEntries(
            [...samples.specs]
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([spec, milliseconds]) => [
                    spec,
                    Math.max(1, Math.round(milliseconds / 1000)),
                ]),
        ),
    };
}

async function main(): Promise<void> {
    const files = process.argv.slice(2).filter((argument) => argument !== '--');
    if (files.length === 0) {
        throw new Error(
            'Usage: e2e-spec-durations.ts <hosted-job-log>... (writes scripts/e2e-spec-durations.json)',
        );
    }
    const logs = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const table = buildSpecDurationTable(collectSpecDurations(logs));
    const target = resolve(fileURLToPath(new URL('..', import.meta.url)), E2E_SPEC_DURATIONS_PATH);
    await writeFile(target, `${JSON.stringify(table, null, 4)}\n`);
    process.stdout.write(
        `Wrote ${Object.keys(table.specs).length} specs to ${E2E_SPEC_DURATIONS_PATH}\n`,
    );
}

if (import.meta.main) {
    await main();
}
