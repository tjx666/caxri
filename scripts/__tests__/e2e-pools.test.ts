import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopExclusiveReason } from '../../e2e/support/pools';
import { createE2EPoolPlan, desktopExclusiveSpecs } from '../../e2e/support/pools';
import type { E2ETestReceipt } from '../reporters/e2e-receipt-reporter';
import E2EReceiptReporter, {
    assertE2EPoolReceipt,
    createE2EPoolReceipt,
    stableErrorIdentity,
} from '../reporters/e2e-receipt-reporter';
import {
    censusTargets,
    combinePoolReceipts,
    finalizeAbortedPool,
    mergeCensusReceipts,
    parseE2EPool,
    playwrightTestArguments,
    readInvocationReceipt,
    resolveParallelWorkers,
    resolvePoolOutcome,
} from '../run-e2e-pools';

const allSpecs = [
    'e2e/editor-dotfiles.e2e.ts',
    'e2e/file-operations.e2e.ts',
    'e2e/process-explorer.e2e.ts',
    'e2e/screencast.e2e.ts',
];

function testReceipt(
    id: string,
    verdict: E2ETestReceipt['verdict'] = 'pass',
    errorIdentity: string | null = null,
    durationMs = verdict === 'skipped' || verdict === 'unknown' ? 0 : 1_000,
): E2ETestReceipt {
    return {
        artifacts: verdict === 'fail' ? [`test-results/${id}/trace.zip`] : [],
        durationMs,
        errorIdentity,
        id,
        location: `e2e/${id}.e2e.ts:1:1`,
        title: id,
        verdict,
    };
}

function receipt(pool: 'control' | 'desktop-exclusive' | 'parallel-safe', tests: E2ETestReceipt[]) {
    return createE2EPoolReceipt({
        finishedAt: '2026-01-01T00:00:01.000Z',
        pool,
        startedAt: '2026-01-01T00:00:00.000Z',
        tests,
    });
}

describe('E2E pools', () => {
    it('records an invocation crash even when the reporter never writes its receipt', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-receipt-'));
        try {
            const missing = await readInvocationReceipt(
                join(directory, 'missing.json'),
                'parallel-safe',
            );
            const outcome = resolvePoolOutcome(
                combinePoolReceipts('parallel-safe', [missing]),
                [{ specs: ['e2e/safe.e2e.ts'] }],
                [137],
            );
            expect(outcome).toMatchObject({
                result: 137,
                receipt: {
                    status: 'failed',
                    missingSpecs: ['e2e/safe.e2e.ts'],
                    abortedInvocations: [{ exitCode: 137, specs: ['e2e/safe.e2e.ts'] }],
                },
            });
            expect(Number.isNaN(Date.parse(outcome.receipt.startedAt))).toBe(false);
            const initial = receipt('parallel-safe', [testReceipt('safe', 'unknown')]);
            expect(mergeCensusReceipts(initial, [missing])).toMatchObject({
                status: 'failed',
                unknown: 1,
            });
            await writeFile(join(directory, 'malformed.json'), '{');
            await expect(
                readInvocationReceipt(join(directory, 'malformed.json'), 'parallel-safe'),
            ).rejects.toThrow();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('requires one explicit logical pool per single-machine job step', () => {
        expect(parseE2EPool(['--pool', 'parallel-safe'])).toBe('parallel-safe');
        expect(parseE2EPool(['--pool', 'desktop-exclusive'])).toBe('desktop-exclusive');
        expect(parseE2EPool(['--pool', 'control'])).toBe('control');
        expect(parseE2EPool(['--pool', 'desktop-exclusive', '--shard', '2/2'])).toBe(
            'desktop-exclusive',
        );
        expect(() => parseE2EPool([])).toThrow('Usage: run-e2e-pools.ts');
        expect(() => parseE2EPool(['--pool', 'unknown'])).toThrow('Usage: run-e2e-pools.ts');
    });

    it('keeps parallel worker experiments bounded and defaults the optimized pool to three', () => {
        expect(resolveParallelWorkers({})).toBe(3);
        expect(resolveParallelWorkers({ CAXRI_E2E_PARALLEL_WORKERS: '2' })).toBe(2);
        expect(resolveParallelWorkers({ CAXRI_E2E_PARALLEL_WORKERS: '4' })).toBe(4);
        expect(() => resolveParallelWorkers({ CAXRI_E2E_PARALLEL_WORKERS: '1' })).toThrow(
            'must be 2, 3, or 4',
        );
    });

    it('admits unclassified specs to parallel-safe and keeps only listed specs desktop-exclusive', () => {
        const plan = createE2EPoolPlan(allSpecs, [
            'e2e/file-operations.e2e.ts',
            'e2e/process-explorer.e2e.ts',
            'e2e/screencast.e2e.ts',
        ]);

        expect(plan.parallelSafe).toEqual(['e2e/editor-dotfiles.e2e.ts']);
        expect(plan.desktopExclusive).toEqual([
            'e2e/file-operations.e2e.ts',
            'e2e/process-explorer.e2e.ts',
            'e2e/screencast.e2e.ts',
        ]);
        expect(new Set([...plan.parallelSafe, ...plan.desktopExclusive]).size).toBe(
            allSpecs.length,
        );
    });

    it('rejects duplicate or unknown desktop-exclusive classifications', () => {
        expect(() =>
            createE2EPoolPlan(allSpecs, ['e2e/screencast.e2e.ts', 'e2e/screencast.e2e.ts']),
        ).toThrow('Duplicate desktop-exclusive E2E spec');
        expect(() => createE2EPoolPlan(allSpecs, ['e2e/missing.e2e.ts'])).toThrow(
            'Unknown desktop-exclusive E2E spec',
        );
    });

    it('never admits known machine-global or lifecycle-sensitive specs to parallel-safe', () => {
        for (const path of [
            'e2e/bug-report.e2e.ts',
            'e2e/codex-compaction.e2e.ts',
            'e2e/desktop-server.e2e.ts',
            'e2e/editor-find.e2e.ts',
            'e2e/editor.performance.e2e.ts',
            'e2e/extensions.e2e.ts',
            'e2e/failure-isolation.e2e.ts',
            'e2e/file-operations.e2e.ts',
            'e2e/logs-panel.e2e.ts',
            'e2e/menu-keybinding-recovery.e2e.ts',
            'e2e/server-platform.e2e.ts',
            'e2e/process-explorer-recovery.e2e.ts',
            'e2e/process-explorer.e2e.ts',
            'e2e/real-agent-smoke.e2e.ts',
            'e2e/screencast.e2e.ts',
            'e2e/session-attention.e2e.ts',
            'e2e/startup.performance.e2e.ts',
            'e2e/terminal-selection.e2e.ts',
            'e2e/terminal-shortcuts.e2e.ts',
            'e2e/terminal-webgl.e2e.ts',
            'e2e/updates.e2e.ts',
            'e2e/window-mode.e2e.ts',
            'e2e/workbench-recovery.e2e.ts',
            'e2e/workbench-root.e2e.ts',
        ]) {
            expect(Object.keys(desktopExclusiveSpecs), path).toContain(path);
        }
    });

    it('records a distinct, explained reason set for every desktop-exclusive spec', () => {
        for (const [path, { reasons, why }] of Object.entries(desktopExclusiveSpecs)) {
            expect(new Set(reasons).size, path).toBe(reasons.length);
            expect(why.trim().length, path).toBeGreaterThan(10);
        }
    });

    /**
     * New specs default to the parallel pool, so the capabilities the source itself declares are what keep one out of
     * it. Deriving them in both directions catches a spec that requests one without being listed (it would also fail at
     * launch inside the pool) and an entry whose capability the spec no longer requests (a stale reason that keeps a
     * now-parallel-safe spec on one worker). A hand-maintained capability list once fell three entries behind this
     * way.
     */
    it('derives mechanical exclusion reasons from the spec sources in both directions', async () => {
        const mechanical: Record<
            Extract<DesktopExclusiveReason, 'clipboard' | 'gpu' | 'visible-window'>,
            RegExp
        > = {
            'clipboard': /clipboard:\s*true/u,
            'gpu': /gpuMode:\s*'enabled'/u,
            'visible-window': /windowMode:\s*'visible'/u,
        };
        const directory = new URL('../../e2e/', import.meta.url);
        const names = (await readdir(directory)).filter((name) => name.endsWith('.e2e.ts'));
        const sources = new Map<string, string>();
        for (const name of names) {
            // eslint-disable-next-line no-await-in-loop -- bounded read of one spec directory
            sources.set(`e2e/${name}`, await readFile(new URL(name, directory), 'utf8'));
        }
        const sorted = (paths: Iterable<string>) =>
            [...paths].toSorted((left, right) => left.localeCompare(right));

        for (const [reason, pattern] of Object.entries(mechanical)) {
            const requesting = [...sources].filter(([, source]) => pattern.test(source));
            const declared = Object.entries(desktopExclusiveSpecs).filter(([, { reasons }]) =>
                reasons.includes(reason as DesktopExclusiveReason),
            );
            expect(sorted(declared.map(([path]) => path)), reason).toStrictEqual(
                sorted(requesting.map(([path]) => path)),
            );
        }
        for (const [path, { reasons }] of Object.entries(desktopExclusiveSpecs)) {
            if (reasons.includes('opt-in-only'))
                expect(sources.get(path), path).toMatch(/test\.skip\(/u);
        }
    });

    it('partitions the current repository manifest without duplicates or omissions', async () => {
        const repoSpecs = (await readdir(new URL('../../e2e', import.meta.url)))
            .filter((name) => name.endsWith('.e2e.ts'))
            .map((name) => `e2e/${name}`)
            .toSorted((left, right) => left.localeCompare(right));
        const plan = createE2EPoolPlan(repoSpecs);

        expect(plan.desktopExclusive).toEqual(
            Object.keys(desktopExclusiveSpecs).toSorted((left, right) => left.localeCompare(right)),
        );
        expect(plan.desktopExclusive.length + plan.parallelSafe.length).toBe(repoSpecs.length);
        expect(
            [...plan.desktopExclusive, ...plan.parallelSafe].toSorted((left, right) =>
                left.localeCompare(right),
            ),
        ).toEqual(repoSpecs);
        expect(plan.parallelSafe).toContain('e2e/settings-parallel-safe.e2e.ts');
        expect(plan.desktopExclusive).toContain('e2e/settings.e2e.ts');
        expect(plan.parallelSafeInvocations).toEqual([{ specs: plan.parallelSafe }]);
        expect(plan.desktopExclusiveInvocations).toEqual([{ specs: plan.desktopExclusive }]);
    });

    it('combines receipt invocations without accepting duplicate tests', () => {
        const combinedReceipt = combinePoolReceipts('parallel-safe', [
            receipt('parallel-safe', [testReceipt('safe')]),
            receipt('parallel-safe', [testReceipt('settings-safe')]),
        ]);

        expect(combinedReceipt).toMatchObject({
            failed: 0,
            finished: 2,
            passed: 2,
            planned: 2,
            skipped: 0,
            started: 2,
            status: 'passed',
        });
        expect(() =>
            combinePoolReceipts('parallel-safe', [
                combinedReceipt,
                createE2EPoolReceipt({
                    finishedAt: combinedReceipt.finishedAt,
                    pool: 'parallel-safe',
                    startedAt: combinedReceipt.startedAt,
                    tests: [combinedReceipt.tests[0]],
                }),
            ]),
        ).toThrow('overlap');
    });

    it('fails the pool when a child exited non-zero even though its receipt passed', () => {
        const invocations = [
            { specs: ['e2e/safe.e2e.ts'] },
            { specs: ['e2e/settings-safe.e2e.ts'] },
        ];
        const passed = receipt('parallel-safe', [
            testReceipt('safe'),
            testReceipt('settings-safe'),
        ]);

        const crashed = resolvePoolOutcome(passed, invocations, [0, 134]);
        expect(crashed.result).toBe(134);
        expect(crashed.receipt).toMatchObject({
            abortedInvocations: [{ exitCode: 134, specs: ['e2e/settings-safe.e2e.ts'] }],
            status: 'failed',
        });
        expect(crashed.receipt.missingSpecs).toBeUndefined();

        // A census re-run is dispatched as `path:line`; its crash counts like any other child's, and the
        // line suffix must not make the spec look missing from the merged receipt.
        const censusCrashed = resolvePoolOutcome(
            passed,
            [...invocations, { specs: ['e2e/settings-safe.e2e.ts:12'] }],
            [0, 0, 1],
        );
        expect(censusCrashed.result).toBe(1);
        expect(censusCrashed.receipt).toMatchObject({
            abortedInvocations: [{ exitCode: 1, specs: ['e2e/settings-safe.e2e.ts:12'] }],
            status: 'failed',
        });
        expect(censusCrashed.receipt.missingSpecs).toBeUndefined();

        const failedReceipt = receipt('parallel-safe', [
            testReceipt('safe', 'fail', 'x'),
            testReceipt('settings-safe'),
        ]);
        expect(resolvePoolOutcome(failedReceipt, invocations, [0, 0])).toEqual({
            receipt: failedReceipt,
            result: 1,
        });

        expect(resolvePoolOutcome(passed, invocations, [0, 0])).toEqual({
            receipt: passed,
            result: 0,
        });
        expect(() => resolvePoolOutcome(passed, invocations, [0])).toThrow(
            'exit codes do not match',
        );
    });

    it('fails the pool when a dispatched spec never reached the reporter', () => {
        const passed = receipt('parallel-safe', [testReceipt('safe')]);
        const outcome = resolvePoolOutcome(
            passed,
            [{ specs: ['e2e/safe.e2e.ts', 'e2e/dropped.e2e.ts'] }],
            [0],
        );

        expect(outcome.result).toBe(1);
        expect(outcome.receipt).toMatchObject({
            missingSpecs: ['e2e/dropped.e2e.ts'],
            status: 'failed',
        });
        expect(() => assertE2EPoolReceipt({ ...outcome.receipt, status: 'passed' })).toThrow(
            'passing receipt is incomplete',
        );
    });

    it('fills suppressed verdicts and groups the same failure identity without losing artifacts', () => {
        const identity = stableErrorIdentity('Expected ready state at /private/tmp/run-a:42:7');
        expect(identity).toBe(
            stableErrorIdentity('Expected ready state at /private/tmp/run-b:99:3'),
        );
        const initial = receipt('parallel-safe', [
            testReceipt('first', 'fail', identity),
            testReceipt('second', 'unknown'),
            testReceipt('third', 'unknown'),
        ]);
        const combined = mergeCensusReceipts(initial, [
            receipt('parallel-safe', [testReceipt('second', 'fail', identity)]),
            receipt('parallel-safe', [testReceipt('third', 'timeout', identity)]),
        ]);

        expect(combined).toMatchObject({
            failureGroups: [{ count: 3, identity }],
            unknown: 0,
        });
        expect(combined.specs.every(({ verdict }) => verdict !== 'unknown')).toBe(true);
        expect(combined.tests[1].artifacts).toEqual(['test-results/second/trace.zip']);
    });

    it('merges same-line parameterized census results without replacing prior verdicts', () => {
        const location = 'e2e/terminal-recovery.e2e.ts:677:5';
        const siblingLocation = 'e2e/terminal-recovery.e2e.ts:677:30';
        const initial = receipt('parallel-safe', [
            { ...testReceipt('known', 'fail', 'original-failure'), location: siblingLocation },
            { ...testReceipt('codex', 'unknown'), location },
            { ...testReceipt('claude', 'unknown'), location: siblingLocation },
        ]);
        const census = receipt('parallel-safe', [
            { ...testReceipt('known', 'pass'), location: siblingLocation },
            { ...testReceipt('codex', 'fail', 'codex-failure'), location },
            { ...testReceipt('claude', 'pass'), location: siblingLocation },
        ]);

        expect(censusTargets(initial.tests).map(({ id }) => id)).toEqual(['codex']);
        const merged = mergeCensusReceipts(initial, [census]);
        expect(merged.unknown).toBe(0);
        expect(merged.tests.map(({ id, verdict }) => [id, verdict])).toEqual([
            ['known', 'fail'],
            ['codex', 'fail'],
            ['claude', 'pass'],
        ]);
        expect(merged.tests[1].errorIdentity).toBe('codex-failure');
        expect(() =>
            mergeCensusReceipts(initial, [receipt('parallel-safe', [testReceipt('unrelated')])]),
        ).toThrow('unexpected test');
        expect(playwrightTestArguments({ specs: [location] }, 1, true, {})).toContain(
            '--max-failures=0',
        );
        expect(playwrightTestArguments({ specs: [location] }, 1, false, {})).not.toContain(
            '--max-failures=0',
        );
        expect(playwrightTestArguments({ specs: [location] }, 1, false, { CI: 'true' })).toContain(
            '--reporter=./scripts/reporters/public-e2e-reporter.ts,./scripts/reporters/e2e-receipt-reporter.ts',
        );
    });

    describe('SIGTERM abort receipts (issue #1446)', () => {
        it('distinguishes completed, signal-killed, and never-run specs on the partial receipt', () => {
            // First invocation finished and passed before the signal arrived.
            const settled = receipt('desktop-exclusive', [testReceipt('safe')]);
            // Second invocation was mid-flight when SIGTERM landed; its child died before the reporter's `onEnd`
            // ever ran, so `readInvocationReceipt` already falls back to an empty receipt for it (see the
            // "records an invocation crash" case above): reproduced directly here as the input the abort path sees.
            const killedInvocation = { specs: ['e2e/killed.e2e.ts'] };
            const neverRunInvocationSpecs = ['e2e/never-run.e2e.ts'];

            const outcome = finalizeAbortedPool(
                settled,
                [{ specs: ['e2e/safe.e2e.ts'] }, killedInvocation],
                [0, 1],
                neverRunInvocationSpecs,
                'SIGTERM',
            );

            expect(outcome.result).toBe(1);
            expect(outcome.receipt).toMatchObject({
                abortReason: 'SIGTERM',
                abortedInvocations: [{ exitCode: 1, specs: ['e2e/killed.e2e.ts'] }],
                status: 'failed',
            });
            // The signal-killed invocation's spec and the invocation the loop never started both read as
            // "never ran" from the receipt's tests, but only the former is also an aborted invocation.
            expect(outcome.receipt.missingSpecs).toEqual(
                expect.arrayContaining(['e2e/killed.e2e.ts', 'e2e/never-run.e2e.ts']),
            );
            expect(outcome.receipt.missingSpecs).toHaveLength(2);
            expect(outcome.receipt.tests.map(({ id }) => id)).toEqual(['safe']);
            expect(() => assertE2EPoolReceipt(outcome.receipt)).not.toThrow();
        });

        it('keeps verdicts the signal-killed invocation settled before onEnd (issue #1847)', async () => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-receipt-killed-'));
            const receiptPath = join(directory, 'parallel-safe-0.json');
            vi.stubEnv('CAXRI_E2E_POOL', 'parallel-safe');
            vi.stubEnv('CAXRI_E2E_RECEIPT_PATH', receiptPath);
            try {
                const testCase = (id: string, spec: string, line: number): TestCase =>
                    ({
                        id,
                        expectedStatus: 'passed',
                        location: { file: resolve(`e2e/${spec}.e2e.ts`), line, column: 1 },
                        titlePath: () => ['', spec, id],
                    }) as TestCase;
                const passing = testCase('passing', 'settled', 1);
                const failing = testCase('failing', 'settled', 9);
                const inFlight = testCase('in-flight', 'partial', 1);
                const partialDone = testCase('partial-done', 'partial', 9);
                const neverStarted = testCase('never-started', 'unstarted', 1);
                const reporter = new E2EReceiptReporter();
                reporter.onBegin(
                    {} as FullConfig,
                    {
                        allTests: () => [passing, failing, inFlight, partialDone, neverStarted],
                    } as Suite,
                );
                const result = (status: string, attachments: Array<{ path?: string }> = []) =>
                    ({
                        status,
                        duration: 250,
                        attachments,
                        errors: status === 'failed' ? [{ message: 'expected visible' }] : [],
                    }) as unknown as TestResult;
                reporter.onTestEnd(passing, result('passed'));
                reporter.onTestEnd(
                    failing,
                    result('failed', [{ path: resolve('test-results/failing/trace.zip') }]),
                );
                reporter.onTestEnd(partialDone, result('passed'));
                // The SIGTERM lands here: Playwright exits before `onEnd`, so no receipt file is written. Simulate the
                // torn final write a kill can leave behind as well.
                await appendFile(`${receiptPath}.progress.jsonl`, '{"type":"end","te');

                const killed = await readInvocationReceipt(receiptPath, 'parallel-safe');
                const outcome = finalizeAbortedPool(
                    combinePoolReceipts('parallel-safe', [killed]),
                    [
                        {
                            specs: [
                                'e2e/partial.e2e.ts',
                                'e2e/settled.e2e.ts',
                                'e2e/unstarted.e2e.ts',
                            ],
                        },
                    ],
                    [143],
                    ['e2e/never-run.e2e.ts'],
                    'SIGTERM',
                );

                expect(outcome.receipt).toMatchObject({
                    abortReason: 'SIGTERM',
                    abortedInvocations: [{ exitCode: 143 }],
                    failed: 1,
                    passed: 2,
                    status: 'failed',
                    unknown: 1,
                });
                expect(
                    Object.fromEntries(
                        outcome.receipt.tests.map((test) => [test.id, test.verdict]),
                    ),
                ).toEqual({
                    'failing': 'fail',
                    'in-flight': 'unknown',
                    'partial-done': 'pass',
                    'passing': 'pass',
                });
                expect(outcome.receipt.tests.find(({ id }) => id === 'failing')).toMatchObject({
                    artifacts: ['test-results/failing/trace.zip'],
                    errorIdentity: stableErrorIdentity('expected visible'),
                });
                expect(
                    outcome.receipt.missingSpecs?.toSorted((left, right) =>
                        left.localeCompare(right),
                    ),
                ).toEqual(['e2e/never-run.e2e.ts', 'e2e/unstarted.e2e.ts']);
            } finally {
                vi.unstubAllEnvs();
                await rm(directory, { recursive: true, force: true });
            }
        });

        it('marks every planned spec never-run when the signal lands before any invocation starts', () => {
            const empty = createE2EPoolReceipt({
                finishedAt: '2026-01-01T00:00:00.000Z',
                pool: 'parallel-safe',
                startedAt: '2026-01-01T00:00:00.000Z',
                tests: [],
            });

            const outcome = finalizeAbortedPool(
                empty,
                [],
                [],
                ['e2e/safe.e2e.ts', 'e2e/settings-safe.e2e.ts'],
                'SIGINT',
            );

            expect(outcome.result).toBe(1);
            expect(outcome.receipt).toMatchObject({
                abortReason: 'SIGINT',
                planned: 0,
                status: 'failed',
            });
            expect(outcome.receipt.abortedInvocations).toBeUndefined();
            expect(outcome.receipt.missingSpecs).toEqual([
                'e2e/safe.e2e.ts',
                'e2e/settings-safe.e2e.ts',
            ]);
        });

        it('still forces status failed when the signal lands after everything already passed', () => {
            const complete = receipt('control', [
                testReceipt('safe'),
                testReceipt('settings-safe'),
            ]);

            const outcome = finalizeAbortedPool(
                complete,
                [{ specs: ['e2e/safe.e2e.ts', 'e2e/settings-safe.e2e.ts'] }],
                [0],
                [],
                'SIGTERM',
            );

            expect(outcome.result).toBe(1);
            expect(outcome.receipt.abortReason).toBe('SIGTERM');
            expect(outcome.receipt.status).toBe('failed');
            expect(outcome.receipt.abortedInvocations).toBeUndefined();
            expect(outcome.receipt.missingSpecs).toBeUndefined();
            // A passing receipt may never carry an abort reason (`assertE2EPoolReceipt` rejects it), which is exactly
            // why `finalizeAbortedPool` overrides `status` unconditionally instead of trusting `resolvePoolOutcome`.
            expect(() => assertE2EPoolReceipt({ ...outcome.receipt, status: 'passed' })).toThrow(
                'passing receipt is incomplete',
            );
        });
    });
});
