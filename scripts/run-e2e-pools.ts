#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import {
    fullSuiteRefusalMessage,
    isFullSuiteAuthorized,
} from '../.agents/skills/quality-check/scripts/full-suite-authorization';
import {
    acquireDesktopLease,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import type { E2EPoolInvocation } from '../e2e/support/pools';
import { createE2EPoolPlan } from '../e2e/support/pools';
import { waitForChildExit } from './exec';
import type {
    E2EAbortedInvocation,
    E2EPoolAbortReason,
    E2EPoolReceipt,
    E2ETestReceipt,
} from './reporters/e2e-receipt-reporter';
import {
    assertE2EPoolCensusComplete,
    assertE2EPoolReceipt,
    createE2EPoolReceipt,
} from './reporters/e2e-receipt-reporter';

const projectRoot = resolve(import.meta.dirname, '..');
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export type E2EPool = 'control' | 'desktop-exclusive' | 'parallel-safe';

/**
 * Set once by {@link installAbortHandlers} when this process receives an {@link E2EPoolAbortReason} signal, grouped
 * behind a single object so functions below mutate a property instead of reassigning a top-level binding
 * (`unicorn/no-top-level-assignment-in-function`). Module state is enough here: `run-e2e-pools.ts` is a one-shot CLI
 * process, `main` calls `installAbortHandlers` exactly once, and every reader is downstream of that same event loop
 * turn.
 */
const poolAbortState: { reason: E2EPoolAbortReason | undefined } = { reason: undefined };

/**
 * Node's default disposition for `SIGINT`/`SIGTERM` is to terminate the process immediately.
 * `ci-concurrent-validation.ts` relies on exactly that to kill a sibling component's process group when a checks
 * failure (or the shared execution deadline) aborts the run — see `ConcurrentValidationProcesses.abort`. Left
 * unhandled, this process dies mid-invocation without writing anything, so whatever E2E failure already happened has no
 * CI-downloadable evidence (issue #1446). Registering a handler here suppresses that default: the in-flight
 * `runInvocation` await still resolves once the signalled Playwright child exits, and the invocation loop in `runPool`
 * checks {@link poolAbortState} before starting another one instead of continuing the pool. A ~2s `SIGKILL` follows the
 * `SIGTERM` (`ConcurrentValidationProcesses`'s force timer), so everything after the signal — reading whatever receipt
 * the current invocation wrote, synthesizing the partial pool receipt, and writing it to disk — has to fit in that
 * window.
 */
function installAbortHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            poolAbortState.reason ??= signal;
        });
    }
}

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

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export function playwrightTestArguments(
    invocation: E2EPoolInvocation,
    workers: number,
    isCensus: boolean,
): string[] {
    return [
        'playwright',
        'test',
        ...invocation.specs,
        `--workers=${workers}`,
        ...(isCensus ? ['--max-failures=0'] : []),
        '--reporter=line,./scripts/reporters/e2e-receipt-reporter.ts',
    ];
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
    await rm(receiptPath, { force: true });
    const child = spawn('bunx', playwrightTestArguments(invocation, workers, isCensus), {
        cwd: projectRoot,
        env: {
            ...process.env,
            CAXRI_E2E_OUTPUT_DIR: `test-results/${pool}${outputSuffix ? `/${outputSuffix}` : ''}`,
            CAXRI_E2E_POOL: pool,
            CAXRI_E2E_RECEIPT_PATH: receiptPath,
            ...(coordinatorToken && { CAXRI_E2E_COORDINATOR_TOKEN: coordinatorToken }),
        },
        stdio: 'inherit',
    });
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

function censusLocation(location: string): string {
    return location.replace(/:\d+$/u, '');
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
    const unknownLocations = new Set(
        initial.tests
            .filter(({ verdict }) => verdict === 'unknown')
            .map(({ location }) => censusLocation(location)),
    );
    for (const receipt of census) {
        assertE2EPoolReceipt(receipt);
        if (receipt.pool !== initial.pool) throw new Error('E2E census pool does not match');
        for (const test of receipt.tests) {
            if (!unknown.has(test.id)) {
                const planned = tests.get(test.id);
                /**
                 * File:line reruns can also report a previously settled parameterized sibling.
                 */
                if (
                    planned?.location !== test.location ||
                    !unknownLocations.has(censusLocation(test.location))
                )
                    throw new Error(`E2E census returned an unexpected test: ${test.id}`);
            } else {
                if (test.verdict === 'unknown') {
                    throw new Error(`E2E census did not produce a verdict for ${test.id}`);
                }
                tests.set(test.id, test);
                unknown.delete(test.id);
            }
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
    return merged;
}

/**
 * One unrestricted census run covers every parameterized test declared at the same file and line.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export function censusTargets(tests: readonly E2ETestReceipt[]): E2ETestReceipt[] {
    const locations = new Set<string>();
    return tests.filter((test) => {
        const location = censusLocation(test.location);
        if (test.verdict !== 'unknown' || locations.has(location)) return false;
        locations.add(location);
        return true;
    });
}

/**
 * Reduces a dispatched spec or a receipt spec path to the identity the two are compared on. The reporter already writes
 * repository-relative paths, so the only difference left is the `:line` suffix a dispatched census spec carries.
 */
function specIdentity(spec: string): string {
    return spec.replace(/(?::\d+)+$/u, '');
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
    const covered = new Set(receipt.specs.map(({ path }) => specIdentity(path)));
    const missingSpecs = invocations
        .flatMap(({ specs }) => specs)
        .map((spec) => specIdentity(spec))
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

/**
 * Builds the partial pool receipt {@link poolAbortState} makes `runPool` write instead of the normal outcome.
 * `executedInvocations`/`exitCodes` cover only invocations the loop actually started, so {@link resolvePoolOutcome}
 * still tells a signal-killed invocation's specs (`abortedInvocations`, since its process exited non-zero) apart from
 * ones the reporter already settled. `neverRunSpecs` covers invocations the loop chose not to start at all once the
 * signal arrived; those are folded into `missingSpecs` too — the receipt has no test entries for them either way — but
 * deliberately kept out of `abortedInvocations`, which means "this invocation's process exited non-zero" and never-
 * started work did not do that. The result is always non-zero and the status always `failed`: an aborted pool never
 * finished proving its own completeness, even on the rare signal that lands after everything already passed.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export function finalizeAbortedPool(
    receipt: E2EPoolReceipt,
    executedInvocations: readonly E2EPoolInvocation[],
    exitCodes: readonly number[],
    neverRunSpecs: readonly string[],
    abortReason: E2EPoolAbortReason,
): { receipt: E2EPoolReceipt; result: number } {
    const outcome = resolvePoolOutcome(receipt, executedInvocations, exitCodes);
    const missingSpecs = [
        ...new Set([...(outcome.receipt.missingSpecs ?? []), ...neverRunSpecs.map(specIdentity)]),
    ];
    const aborted: E2EPoolReceipt = {
        ...outcome.receipt,
        abortReason,
        ...(missingSpecs.length > 0 && { missingSpecs }),
        status: 'failed',
    };
    assertE2EPoolReceipt(aborted);
    return { receipt: aborted, result: outcome.result || 1 };
}

async function writeReceipt(path: string, receipt: E2EPoolReceipt): Promise<void> {
    await mkdir(resolve(path, '..'), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/e2e-pools.test.ts
export async function readInvocationReceipt(path: string, pool: E2EPool): Promise<E2EPoolReceipt> {
    try {
        const receipt = JSON.parse(await readFile(path, 'utf8')) as E2EPoolReceipt;
        if (receipt.pool !== pool) throw new Error('E2E invocation pool does not match');
        return receipt;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        /**
         * A crash before onEnd has no test verdicts to census. Preserve that absence so the final receipt records the
         * invocation's exit code and missing specs instead of failing before it can publish any evidence.
         */
        const now = new Date().toISOString();
        return createE2EPoolReceipt({ pool, startedAt: now, finishedAt: now, tests: [] });
    }
}

async function runPool(
    invocations: readonly E2EPoolInvocation[],
    pool: E2EPool,
    workers: number,
    coordinatorToken?: string,
): Promise<{ receipt: E2EPoolReceipt; result: number }> {
    const finalReceiptPath = `test-results/receipts/${pool}.json`;
    await rm(finalReceiptPath, { force: true });
    const receiptPaths = invocations.map(
        (_invocation, index) => `test-results/receipts/${pool}-${index}.json`,
    );
    const exitCodes: number[] = [];
    let executedCount = 0;
    // Only one Electron/Desktop-driving Playwright invocation may run at a time (see
    // AGENTS.md: "Never run Electron desktop tasks concurrently"), so pool invocations
    // must execute sequentially rather than via Promise.all. Checking poolAbortState.reason before
    // each invocation, instead of only after the loop, keeps this process from spawning fresh work
    // once ci-concurrent-validation.ts has already signalled an abort (see installAbortHandlers).
    for (const invocation of invocations) {
        if (poolAbortState.reason) break;
        // eslint-disable-next-line no-await-in-loop -- sequential Electron desktop invocations only
        const code = await runInvocation(
            invocation,
            pool,
            workers,
            receiptPaths[executedCount],
            coordinatorToken,
        );
        exitCodes.push(code);
        executedCount += 1;
    }
    const executedInvocations = invocations.slice(0, executedCount);
    const neverRunSpecs = invocations.slice(executedCount).flatMap(({ specs }) => specs);
    const receipts = await Promise.all(
        receiptPaths.slice(0, executedCount).map((path) => readInvocationReceipt(path, pool)),
    );
    const now = new Date().toISOString();
    const baseReceipt =
        receipts.length > 0
            ? combinePoolReceipts(pool, receipts)
            : createE2EPoolReceipt({ finishedAt: now, pool, startedAt: now, tests: [] });
    const abortReasonAfterMainLoop = poolAbortState.reason;
    if (abortReasonAfterMainLoop) {
        const outcome = finalizeAbortedPool(
            baseReceipt,
            executedInvocations,
            exitCodes,
            neverRunSpecs,
            abortReasonAfterMainLoop,
        );
        await writeReceipt(finalReceiptPath, outcome.receipt);
        return outcome;
    }
    const censusReceipts: E2EPoolReceipt[] = [];
    const censusInvocations: E2EPoolInvocation[] = [];
    const unknownTests = censusTargets(baseReceipt.tests).entries();
    for (const [index, test] of unknownTests) {
        if (poolAbortState.reason) break;
        const censusPath = `test-results/receipts/${pool}-census-${index}.json`;
        const line = /:(\d+):\d+$/u.exec(test.location)?.[1];
        const censusInvocation = { specs: [`${specIdentity(test.location)}:${line ?? '1'}`] };
        // eslint-disable-next-line no-await-in-loop -- sequential Electron desktop invocations only
        const censusCode = await runInvocation(
            censusInvocation,
            pool,
            1,
            censusPath,
            coordinatorToken,
            true,
            `census-${index}`,
        );
        // A census child is held to the same rule as the pool children: a crash after its receipt is written
        // must not let the receipt's verdicts stand.
        censusInvocations.push(censusInvocation);
        exitCodes.push(censusCode);
        // eslint-disable-next-line no-await-in-loop -- reads the receipt just written by the preceding sequential invocation
        censusReceipts.push(await readInvocationReceipt(censusPath, pool));
    }
    const merged = mergeCensusReceipts(baseReceipt, censusReceipts);
    const allInvocations = [...executedInvocations, ...censusInvocations];
    const abortReasonAfterCensus = poolAbortState.reason;
    if (abortReasonAfterCensus) {
        const outcome = finalizeAbortedPool(
            merged,
            allInvocations,
            exitCodes,
            neverRunSpecs,
            abortReasonAfterCensus,
        );
        await writeReceipt(finalReceiptPath, outcome.receipt);
        return outcome;
    }
    const outcome = resolvePoolOutcome(merged, allInvocations, exitCodes);
    await writeReceipt(finalReceiptPath, outcome.receipt);
    assertE2EPoolCensusComplete(outcome.receipt);
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

async function main(): Promise<void> {
    installAbortHandlers();
    const pool = parseE2EPool(process.argv.slice(2));
    /**
     * Every pool hands Playwright an explicit spec list, which the `globalSetup` guard reads as a focused run. Refuse
     * here instead, or this script is an unguarded path to the full Electron suite.
     */
    if (!isFullSuiteAuthorized()) {
        process.stderr.write(`${fullSuiteRefusalMessage('e2e')}\n`);
        process.exitCode = 1;
        return;
    }
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
        /**
         * A pool the abort path stopped early may still have a worker mid-teardown when its process group is signalled;
         * that is an expected side effect of the abort, not a new lease leak to fail on top of it.
         */
        if (!execution.receipt.abortReason) {
            await assertParallelLeasesReleased(parallelWorkers);
        }
    } else {
        execution = await runPool(invocations, pool, 1);
    }
    await appendSummary(plan, pool, execution.receipt, execution.result, parallelWorkers);
    if (execution.result !== 0) process.exitCode = 1;
}

if (import.meta.main) await main();
