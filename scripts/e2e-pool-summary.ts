import { appendFile } from 'node:fs/promises';
import process from 'node:process';

import type { createE2EPoolPlan } from '../e2e/support/pools';
import type { E2EShard } from './e2e-pool-shard';
import type { E2EPoolReceipt } from './reporters/e2e-receipt-reporter';

/**
 * Appends the pool's execution row and slowest-spec table to the Actions step summary. A sharded run labels its row
 * with the shard and counts the specs its receipt covers.
 */
export async function appendPoolSummary(
    plan: ReturnType<typeof createE2EPoolPlan>,
    pool: 'control' | 'desktop-exclusive' | 'parallel-safe',
    receipt: E2EPoolReceipt,
    result: number,
    parallelWorkers: number,
    shard?: E2EShard,
): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    const invocations =
        pool === 'control'
            ? [
                  {
                      specs: [...plan.parallelSafe, ...plan.desktopExclusive].toSorted(
                          (left, right) => left.localeCompare(right),
                      ),
                  },
              ]
            : pool === 'parallel-safe'
              ? plan.parallelSafeInvocations
              : plan.desktopExclusiveInvocations;
    const specs = shard
        ? receipt.specs.length
        : new Set(invocations.flatMap((invocation) => invocation.specs)).size;
    const workers = pool === 'parallel-safe' ? parallelWorkers : 1;
    await appendFile(
        summary,
        [
            '## E2E pool execution',
            '',
            '| Pool | Specs | Planned | Started | Finished | Passed | Skipped | Failed | Timeout | Unknown | Workers | Result |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            `| \`${pool}\`${shard ? ` (shard ${shard.index}/${shard.total})` : ''} | ${specs} | ${receipt.planned} | ${receipt.started} | ${receipt.finished} | ${receipt.passed} | ${receipt.skipped} | ${receipt.failed} | ${receipt.timedOut} | ${receipt.unknown} | ${workers} | ${result === 0 ? 'passed' : 'failed'} |`,
            '',
            ...slowestSpecSummary(receipt, workers),
        ].join('\n'),
    );
}

/**
 * The ten costliest specs, so the next balancing decision reads a receipt instead of reconstructing durations from
 * job-log timestamps. `share` is the spec's cost against the pool's own serial total, which is the number that matters
 * when deciding what to move between pools; on a multi-worker pool the serial total deliberately exceeds wall time.
 */
function slowestSpecSummary(receipt: E2EPoolReceipt, workers: number): string[] {
    const ranked = [...receipt.specs].toSorted((left, right) => right.durationMs - left.durationMs);
    if (ranked.length === 0) return [];
    const serialTotal = ranked.reduce((total, { durationMs }) => total + durationMs, 0);
    const seconds = (value: number): string => `${(value / 1000).toFixed(1)}s`;
    return [
        `<details><summary>Slowest specs (${seconds(serialTotal)} across ${ranked.length} specs, ${workers} worker${workers === 1 ? '' : 's'})</summary>`,
        '',
        '| Spec | Duration | Share |',
        '| --- | ---: | ---: |',
        ...ranked
            .slice(0, 10)
            .map(
                (spec) =>
                    `| \`${spec.path.replace(/^.*\/e2e\//u, 'e2e/')}\` | ${seconds(spec.durationMs)} | ${serialTotal === 0 ? '0.0' : ((spec.durationMs / serialTotal) * 100).toFixed(1)}% |`,
            ),
        '',
        '</details>',
        '',
    ];
}
