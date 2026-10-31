import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import type { E2EPoolInvocation } from '../e2e/support/pools';
import type { E2ESpecDurationTable } from './e2e-spec-durations';
import { E2E_SPEC_DURATIONS_PATH } from './e2e-spec-durations';

/**
 * One slice of the `parallel-safe` or `desktop-exclusive` pool. Hosted-full runs each pool as slices on separate
 * runners so no single runner's wall time exceeds the 25-minute window (#1869). `desktop-exclusive` only means one
 * Electron at a time per machine, so two runners may each run their own half.
 */
export interface E2EShard {
    index: number;
    total: number;
}

/**
 * Reads `--shard <index>/<total>` from the arguments, falling back to `CAXRI_E2E_SHARD`. Absent means the whole pool.
 */
export function parseE2EShard(
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
): E2EShard | undefined {
    const flag = arguments_.indexOf('--shard');
    const value = flag === -1 ? environment.CAXRI_E2E_SHARD : arguments_[flag + 1];
    if (value === undefined || value === '') return undefined;
    const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
    if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > 16) {
        throw new Error('The E2E shard must be <index>/<total> with 1 <= index <= total <= 16');
    }
    return { index: Number(match[1]), total: Number(match[2]) };
}

/**
 * Approximates how many tests a spec declares, so shards balance by work instead of by file count. A spec that matches
 * nothing still weighs one, because its launch cost is real.
 */
export function specWeight(source: string): number {
    return Math.max(1, source.match(/^\s*test(?:\.\w+)?\(/gmu)?.length ?? 0);
}

/**
 * Weighs each spec by its measured seconds from the committed duration table, so long specs spread across shards. A
 * spec the table does not know (a new one) costs its declared test count times the table's median single-test duration,
 * which keeps it comparable with measured entries until the table is regenerated.
 */
export function measuredSpecWeights(
    specs: readonly string[],
    table: E2ESpecDurationTable,
    declaredWeights: ReadonlyMap<string, number>,
): Map<string, number> {
    return new Map(
        specs.map((spec) => [
            spec,
            table.specs[spec] ?? (declaredWeights.get(spec) ?? 1) * table.medianTestSeconds,
        ]),
    );
}

/**
 * Reads the committed duration table and weighs the specs by it, reading sources only for unmeasured specs.
 */
export async function loadSpecWeights(
    specs: readonly string[],
    projectRoot: string,
): Promise<Map<string, number>> {
    const table = JSON.parse(
        await readFile(resolve(projectRoot, E2E_SPEC_DURATIONS_PATH), 'utf8'),
    ) as E2ESpecDurationTable;
    const unmeasured = specs.filter((spec) => table.specs[spec] === undefined);
    const declared = new Map(
        await Promise.all(
            unmeasured.map(
                async (spec) =>
                    [spec, specWeight(await readFile(resolve(projectRoot, spec), 'utf8'))] as const,
            ),
        ),
    );
    return measuredSpecWeights(specs, table, declared);
}

/**
 * Splits the specs into `shard.total` slices and returns the one at `shard.index`. Greedy longest-first assignment on
 * the weights (measured seconds, see `measuredSpecWeights`), with name order as the tie-break, so every runner derives
 * the identical partition from the identical checkout without a coordinator. Each spec lands in exactly one slice, and
 * a slice's receipt is therefore validated against exactly the specs it was dispatched (`resolvePoolOutcome` in
 * `run-e2e-pools.ts`). Playwright's own `--shard` is deliberately not used: validating a shard against it would require
 * listing the shard with a JSON reporter override, which the public log boundary confines to
 * `scripts/reporters/public-e2e-reporter-policy.ts`.
 */
export function shardSpecs(
    specs: readonly string[],
    weights: ReadonlyMap<string, number>,
    shard: E2EShard,
): string[] {
    const weightOf = (spec: string): number => weights.get(spec) ?? 1;
    const slices = Array.from({ length: shard.total }, () => ({ load: 0, specs: [] as string[] }));
    const ordered = [...specs].toSorted(
        (left, right) => weightOf(right) - weightOf(left) || left.localeCompare(right),
    );
    for (const spec of ordered) {
        const lightest = slices.reduce((best, slice) => (slice.load < best.load ? slice : best));
        lightest.load += weightOf(spec);
        lightest.specs.push(spec);
    }
    return slices[shard.index - 1].specs.toSorted((left, right) => left.localeCompare(right));
}

/**
 * Narrows each dispatched invocation to the specs this shard owns. An invocation the shard owns nothing of is dropped,
 * since Playwright fails on an empty spec list.
 */
export async function narrowInvocationsToShard(
    invocations: readonly E2EPoolInvocation[],
    shard: E2EShard,
    projectRoot: string,
): Promise<E2EPoolInvocation[]> {
    const specs = invocations.flatMap((invocation) => invocation.specs);
    const weights = await loadSpecWeights(specs, projectRoot);
    const owned = new Set(shardSpecs(specs, weights, shard));
    return invocations
        .map((invocation) => ({ specs: invocation.specs.filter((spec) => owned.has(spec)) }))
        .filter((invocation) => invocation.specs.length > 0);
}
