#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

import {
    acquireDesktopLease,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import type { E2EPoolInvocation } from '../e2e/support/pools';
import { createE2EPoolPlan } from '../e2e/support/pools';
import { waitForChildExit } from './exec';
import type { E2EAbortedInvocation, E2EPoolReceipt } from './reporters/e2e-receipt-reporter';
import {
    assertE2EPoolCensusComplete,
    assertE2EPoolReceipt,
    createE2EPoolReceipt,
} from './reporters/e2e-receipt-reporter';

const projectRoot = resolve(import.meta.dirname, '..');
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export type E2EPool = 'control' | 'desktop-exclusive' | 'parallel-safe';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export function resolveParallelWorkers(environment: NodeJS.ProcessEnv): number {
    const value = environment.CAXRI_E2E_PARALLEL_WORKERS ?? '3';
    if (!['2', '3', '4'].includes(value)) {
        throw new Error('CAXRI_E2E_PARALLEL_WORKERS must be 2, 3, or 4');
    }
    return Number(value);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export function parseE2EPool(arguments_: readonly string[]): E2EPool {
    if (
        arguments_.length !== 2 ||
        arguments_[0] !== '--pool' ||
        !['control', 'desktop-exclusive', 'parallel-safe'].includes(arguments_[1])
    ) {
        throw new Error('Usage: run-e2e-pools.ts --pool <control|parallel-safe|desktop-exclusive>');
    }
    return arguments_[1] as E2EPool;
}

async function discoverE2ESpecs(): Promise<string[]> {
    return (await readdir(resolve(projectRoot, 'e2e'), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.e2e.ts'))
        .map((entry) => `e2e/${entry.name}`)
        .toSorted((left, right) => left.localeCompare(right));
}

async function runInvocation(
    invocation: E2EPoolInvocation,
    pool: E2EPool,
    workers: number,
    receiptPath: string,
    coordinatorToken?: string,
    isCensus = false,
    outputSuffix?: string,
): Promise<number> {
    const child = spawn(
        'bunx',
        [
            'playwright',
            'test',
            ...invocation.specs,
            `--workers=${workers}`,
            ...(isCensus ? ['--max-failures=1'] : []),
            '--reporter=line,./scripts/reporters/e2e-receipt-reporter.ts',
        ],
        {
            cwd: projectRoot,
            env: {
                ...process.env,
                CAXRI_E2E_OUTPUT_DIR: `test-results/${pool}${outputSuffix ? `/${outputSuffix}` : ''}`,
                CAXRI_E2E_POOL: pool,
                CAXRI_E2E_RECEIPT_PATH: receiptPath,
                ...(coordinatorToken && { CAXRI_E2E_COORDINATOR_TOKEN: coordinatorToken }),
            },
            stdio: 'inherit',
        },
    );
    return waitForChildExit(child);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export function combinePoolReceipts(
    pool: E2EPool,
    receipts: readonly E2EPoolReceipt[],
): E2EPoolReceipt {
    for (const receipt of receipts) assertE2EPoolReceipt(receipt);
    if (receipts.length === 0 || receipts.some((receipt) => receipt.pool !== pool)) {
        throw new Error(`E2E ${pool} receipt invocations are incomplete`);
    }
    const tests = receipts.flatMap((receipt) => receipt.tests);
    if (new Set(tests.map((test) => test.id)).size !== tests.length) {
        throw new Error(`E2E ${pool} receipt invocations overlap in tests`);
    }
    const combined = createE2EPoolReceipt({
        finishedAt:
            receipts
                .map((receipt) => receipt.finishedAt)
                .toSorted((left, right) => left.localeCompare(right))
                .at(-1) ?? '',
        pool,
        startedAt:
            receipts
                .map((receipt) => receipt.startedAt)
                .toSorted((left, right) => left.localeCompare(right))[0] ?? '',
        tests,
    });
    return combined;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/run-e2e-census-fixture.ts and scripts/__tests__/e2e-pools.test.ts
export function mergeCensusReceipts(
    initial: E2EPoolReceipt,
    census: readonly E2EPoolReceipt[],
): E2EPoolReceipt {
    assertE2EPoolReceipt(initial);
    const tests = new Map(initial.tests.map((test) => [test.id, test]));
    const unknown = new Set(
        initial.tests.filter(({ verdict }) => verdict === 'unknown').map(({ id }) => id),
    );
    for (const receipt of census) {
        assertE2EPoolReceipt(receipt);
        if (receipt.pool !== initial.pool) throw new Error('E2E census pool does not match');
        for (const test of receipt.tests) {
            if (!unknown.has(test.id)) {
                throw new Error(`E2E census returned an unexpected test: ${test.id}`);
            }
            if (test.verdict === 'unknown') {
                throw new Error(`E2E census did not produce a verdict for ${test.id}`);
            }
            tests.set(test.id, test);
            unknown.delete(test.id);
        }
    }
    const merged = createE2EPoolReceipt({
        finishedAt:
            [initial, ...census]
                .map(({ finishedAt }) => finishedAt)
                .toSorted((left, right) => left.localeCompare(right))
                .at(-1) ?? initial.finishedAt,
        pool: initial.pool,
        startedAt: initial.startedAt,
        tests: tests.values().toArray(),
    });
    assertE2EPoolCensusComplete(merged);
    return merged;
}

function projectRelativeSpec(spec: string): string {
    const file = spec.replace(/(?::\d+)+$/u, '');
    return isAbsolute(file) ? relative(projectRoot, file) : file;
}

/**
 * Turns the child exit codes and the merged receipt into one pool verdict. The reporter writes a receipt only when
 * Playwright reaches `onEnd`, so the receipt can read `passed` while the process itself exited non-zero afterwards
 * (global teardown, an unhandled rejection at exit, a signal) or while a dispatched spec never reached the reporter at
 * all. Both signals are therefore required: every child exited zero, every dispatched spec is in the receipt, and the
 * receipt itself passed. A non-zero child exit is recorded on the receipt so the artifact explains the red job.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export function resolvePoolOutcome(
    receipt: E2EPoolReceipt,
    invocations: readonly E2EPoolInvocation[],
    exitCodes: readonly number[],
): { receipt: E2EPoolReceipt; result: number } {
    if (exitCodes.length !== invocations.length) {
        throw new Error(`E2E ${receipt.pool} exit codes do not match its invocations`);
    }
    const abortedInvocations: E2EAbortedInvocation[] = invocations.flatMap((invocation, index) =>
        exitCodes[index] === 0 ? [] : [{ exitCode: exitCodes[index], specs: invocation.specs }],
    );
    const covered = new Set(receipt.specs.map(({ path }) => projectRelativeSpec(path)));
    const missingSpecs = invocations
        .flatMap(({ specs }) => specs)
        .map((spec) => projectRelativeSpec(spec))
        .filter((spec) => !covered.has(spec));
    if (abortedInvocations.length === 0 && missingSpecs.length === 0) {
        return { receipt, result: receipt.status === 'passed' ? 0 : 1 };
    }
    return {
        receipt: {
            ...receipt,
            ...(abortedInvocations.length > 0 && { abortedInvocations }),
            ...(missingSpecs.length > 0 && { missingSpecs }),
            status: 'failed',
        },
        result: abortedInvocations[0]?.exitCode || 1,
    };
}

async function writeReceipt(path: string, receipt: E2EPoolReceipt): Promise<void> {
    await mkdir(resolve(path, '..'), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
}

async function runPool(
    invocations: readonly E2EPoolInvocation[],
    pool: E2EPool,
    workers: number,
    coordinatorToken?: string,
): Promise<{ receipt: E2EPoolReceipt; result: number }> {
    const receiptPaths = invocations.map(
        (_invocation, index) => `test-results/receipts/${pool}-${index}.json`,
    );
    const exitCodes: number[] = [];
    // Only one Electron/Desktop-driving Playwright invocation may run at a time (see
    // AGENTS.md: "Never run Electron desktop tasks concurrently"), so pool invocations
    // must execute sequentially rather than via Promise.all.
    for (const [index, invocation] of invocations.entries()) {
        // eslint-disable-next-line no-await-in-loop -- sequential Electron desktop invocations only
        const code = await runInvocation(
            invocation,
            pool,
            workers,
            receiptPaths[index],
            coordinatorToken,
        );
        exitCodes.push(code);
    }
    const receipts = await Promise.all(
        receiptPaths.map(
            async (path) => JSON.parse(await readFile(path, 'utf8')) as E2EPoolReceipt,
        ),
    );
    const receipt = combinePoolReceipts(pool, receipts);
    const censusReceipts: E2EPoolReceipt[] = [];
    const unknownTests = receipt.tests.filter(({ verdict }) => verdict === 'unknown').entries();
    for (const [index, test] of unknownTests) {
        const censusPath = `test-results/receipts/${pool}-census-${index}.json`;
        const file = test.location.replace(/:\d+:\d+$/u, '');
        const location = isAbsolute(file) ? relative(projectRoot, file) : file;
        const line = /:(\d+):\d+$/u.exec(test.location)?.[1];
        // eslint-disable-next-line no-await-in-loop -- sequential Electron desktop invocations only
        await runInvocation(
            { specs: [`${location}:${line ?? '1'}`] },
            pool,
            1,
            censusPath,
            coordinatorToken,
            true,
            `census-${index}`,
        );
        // eslint-disable-next-line no-await-in-loop -- reads the receipt just written by the preceding sequential invocation
        censusReceipts.push(JSON.parse(await readFile(censusPath, 'utf8')) as E2EPoolReceipt);
    }
    const outcome = resolvePoolOutcome(
        mergeCensusReceipts(receipt, censusReceipts),
        invocations,
        exitCodes,
    );
    await writeReceipt(`test-results/receipts/${pool}.json`, outcome.receipt);
    return outcome;
}

async function assertParallelLeasesReleased(parallelWorkers: number): Promise<void> {
    const namespaces = Array.from(
        { length: parallelWorkers },
        (_value, index) => `e2e-worker-${index}`,
    );
    const statuses = await Promise.all(
        namespaces.map((namespace) => inspectDesktopLease(projectRoot, { namespace })),
    );
    statuses.forEach((status, index) => {
        if (status.state !== 'free') {
            throw new Error(
                `Parallel E2E worker ${index} left a ${status.state} ${namespaces[index]} lease`,
            );
        }
    });
}

async function appendSummary(
    plan: ReturnType<typeof createE2EPoolPlan>,
    pool: E2EPool,
    receipt: E2EPoolReceipt,
    result: number,
    parallelWorkers: number,
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
    const specs = new Set(invocations.flatMap((invocation) => invocation.specs)).size;
    const workers = pool === 'parallel-safe' ? parallelWorkers : 1;
    await appendFile(
        summary,
        [
            '## E2E pool execution',
            '',
            '| Pool | Specs | Planned | Started | Finished | Passed | Skipped | Failed | Timeout | Unknown | Workers | Result |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            `| \`${pool}\` | ${specs} | ${receipt.planned} | ${receipt.started} | ${receipt.finished} | ${receipt.passed} | ${receipt.skipped} | ${receipt.failed} | ${receipt.timedOut} | ${receipt.unknown} | ${workers} | ${result === 0 ? 'passed' : 'failed'} |`,
            '',
        ].join('\n'),
    );
}

async function main(): Promise<void> {
    const pool = parseE2EPool(process.argv.slice(2));
    const parallelWorkers = resolveParallelWorkers(process.env);
    const plan = createE2EPoolPlan(await discoverE2ESpecs());
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
    let execution: { receipt: E2EPoolReceipt; result: number };
    if (pool === 'parallel-safe') {
        const coordinator = await acquireDesktopLease(
            projectRoot,
            'Parallel-safe E2E pool coordinator',
        );
        try {
            execution = await runPool(invocations, pool, parallelWorkers, coordinator.token);
        } finally {
            await releaseDesktopLease(coordinator);
        }
        await assertParallelLeasesReleased(parallelWorkers);
    } else {
        execution = await runPool(invocations, pool, 1);
    }
    await appendSummary(plan, pool, execution.receipt, execution.result, parallelWorkers);
    if (execution.result !== 0) process.exitCode = 1;
}

if (import.meta.main) await main();
