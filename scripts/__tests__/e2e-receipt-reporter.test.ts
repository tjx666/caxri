import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { describe, expect, it, vi } from 'vitest';

import type { E2EPoolReceipt, E2ETestReceipt } from '../reporters/e2e-receipt-reporter';
import E2EReceiptReporter, {
    assertE2EPoolReceipt,
    createE2EPoolReceipt,
    summarizeE2ETests,
} from '../reporters/e2e-receipt-reporter';

it('leaves an interrupted test unknown so the pool census executes it independently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-receipt-interrupted-'));
    const path = join(directory, 'receipt.json');
    vi.stubEnv('CAXRI_E2E_POOL', 'parallel-safe');
    vi.stubEnv('CAXRI_E2E_RECEIPT_PATH', path);
    try {
        const reporter = new E2EReceiptReporter();
        const interrupted = {
            id: 'interrupted',
            expectedStatus: 'passed',
            location: { file: resolve('e2e/example.e2e.ts'), line: 1, column: 1 },
            titlePath: () => ['', 'example', 'interrupted'],
        } as TestCase;
        reporter.onBegin({} as FullConfig, { allTests: () => [interrupted] } as Suite);
        reporter.onTestEnd(interrupted, {
            status: 'interrupted',
            duration: 100,
            attachments: [],
            errors: [{ message: 'Target page, context or browser has been closed' }],
        } as unknown as TestResult);
        await reporter.onEnd();
        const result = JSON.parse(await readFile(path, 'utf8')) as E2EPoolReceipt;
        expect(result.tests).toEqual([
            expect.objectContaining({ verdict: 'unknown', errorIdentity: null, durationMs: 100 }),
        ]);
        // The complete receipt supersedes the per-test progress journal (issue #1847).
        await expect(access(`${path}.progress.jsonl`)).rejects.toThrow();
    } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    }
});

it('keeps the first failed attempt when a retried test passes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-receipt-flaky-'));
    const path = join(directory, 'receipt.json');
    vi.stubEnv('CAXRI_E2E_POOL', 'release-packaged');
    vi.stubEnv('CAXRI_E2E_RECEIPT_PATH', path);
    try {
        const reporter = new E2EReceiptReporter();
        const flaky = {
            id: 'flaky',
            expectedStatus: 'passed',
            location: { file: resolve('e2e/startup.performance.e2e.ts'), line: 1, column: 1 },
            titlePath: () => ['', 'startup', 'budget'],
        } as TestCase;
        reporter.onBegin({} as FullConfig, { allTests: () => [flaky] } as Suite);
        reporter.onTestEnd(flaky, {
            status: 'failed',
            retry: 0,
            duration: 100,
            attachments: [],
            errors: [{ message: 'expected 3355 to be less than 3000' }],
        } as unknown as TestResult);
        reporter.onTestEnd(flaky, {
            status: 'passed',
            retry: 1,
            duration: 50,
            attachments: [],
            errors: [],
        } as unknown as TestResult);
        await reporter.onEnd();
        const result = JSON.parse(await readFile(path, 'utf8')) as E2EPoolReceipt;
        expect(result.status).toBe('passed');
        const [test] = result.tests;
        expect(test).toMatchObject({ durationMs: 150, errorIdentity: null, verdict: 'pass' });
        expect(test.firstFailure?.verdict).toBe('fail');
        expect(test.firstFailure?.errorIdentity).toMatch(/^[a-f\d]{64}$/u);
    } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    }
});

function receipt(overrides: Partial<E2ETestReceipt> = {}): E2ETestReceipt {
    return {
        artifacts: [],
        durationMs: 0,
        errorIdentity: null,
        id: 'suite > case',
        location: 'e2e/example.e2e.ts:1:1',
        title: 'case',
        verdict: 'pass',
        ...overrides,
    };
}

/**
 * `summarizeE2ETests` is reachable production code: `createE2EPoolReceipt` in the same module calls it to derive the
 * `hash` field of every `E2EPoolReceipt` (see `scripts/reporters/e2e-receipt-reporter.ts:135`), and that receipt hash
 * is what `scripts/report-e2e-manifest.ts` and `scripts/run-e2e-pools.ts` persist and compare across CI runs. It is not
 * dead code, but its own identity contract (order- and verdict-independence) was previously only exercised indirectly
 * through `createE2EPoolReceipt` fixtures, so this file tests it directly.
 */
describe('summarizeE2ETests', () => {
    it('is deterministic for the same test list', () => {
        const tests = [receipt({ id: 'a' }), receipt({ id: 'b' })];

        expect(summarizeE2ETests(tests)).toBe(summarizeE2ETests(tests));
    });

    it('is independent of input order', () => {
        const first = receipt({ id: 'a', location: 'e2e/a.e2e.ts:1:1', title: 'a' });
        const second = receipt({ id: 'b', location: 'e2e/b.e2e.ts:1:1', title: 'b' });

        expect(summarizeE2ETests([first, second])).toBe(summarizeE2ETests([second, first]));
    });

    it('does not mutate the input array while sorting', () => {
        const first = receipt({ id: 'b' });
        const second = receipt({ id: 'a' });
        const tests = [first, second];

        summarizeE2ETests(tests);

        expect(tests).toEqual([first, second]);
    });

    it('changes when a test id changes', () => {
        const original = [receipt({ id: 'a' })];
        const renamed = [receipt({ id: 'a-renamed' })];

        expect(summarizeE2ETests(original)).not.toBe(summarizeE2ETests(renamed));
    });

    it('changes when a test location or title changes', () => {
        const baseline = [receipt({ location: 'e2e/example.e2e.ts:1:1', title: 'case' })];
        const movedLocation = [receipt({ location: 'e2e/example.e2e.ts:2:1', title: 'case' })];
        const renamedTitle = [receipt({ location: 'e2e/example.e2e.ts:1:1', title: 'renamed' })];

        expect(summarizeE2ETests(baseline)).not.toBe(summarizeE2ETests(movedLocation));
        expect(summarizeE2ETests(baseline)).not.toBe(summarizeE2ETests(renamedTitle));
    });

    it('ignores fields outside id, location, and title (verdict, artifacts, errorIdentity)', () => {
        const passing = [receipt({ artifacts: [], errorIdentity: null, verdict: 'pass' })];
        const failing = [
            receipt({
                artifacts: ['test-results/example/trace.zip'],
                errorIdentity: 'deadbeef',
                verdict: 'fail',
            }),
        ];

        expect(summarizeE2ETests(passing)).toBe(summarizeE2ETests(failing));
    });

    it('produces a stable hash for an empty test list', () => {
        expect(summarizeE2ETests([])).toBe(summarizeE2ETests([]));
        expect(summarizeE2ETests([])).toMatch(/^[a-f0-9]{64}$/);
    });

    it('ignores durationMs, so recording durations cannot move an existing manifest hash', () => {
        expect(summarizeE2ETests([receipt({ durationMs: 0 })])).toBe(
            summarizeE2ETests([receipt({ durationMs: 91_234 })]),
        );
    });
});

/**
 * Spec durations are what pool-balancing decisions read, so the aggregation and its bounds are pinned here rather than
 * left to the Playwright integration that produces them.
 */
describe('receipt durations', () => {
    const pooled = (tests: E2ETestReceipt[]) =>
        createE2EPoolReceipt({
            finishedAt: '2026-01-01T00:00:01.000Z',
            pool: 'desktop-exclusive',
            startedAt: '2026-01-01T00:00:00.000Z',
            tests,
        });

    it('sums every test of a spec into that spec"s duration', () => {
        const built = pooled([
            receipt({ durationMs: 1_500, id: 'a', location: 'e2e/one.e2e.ts:1:1' }),
            receipt({ durationMs: 2_500, id: 'b', location: 'e2e/one.e2e.ts:9:1' }),
            receipt({ durationMs: 400, id: 'c', location: 'e2e/two.e2e.ts:1:1' }),
        ]);

        expect(built.specs.map(({ durationMs, path }) => [path, durationMs])).toStrictEqual([
            ['e2e/one.e2e.ts', 4_000],
            ['e2e/two.e2e.ts', 400],
        ]);
    });

    it('charges a never-run test zero rather than omitting the field', () => {
        const built = pooled([
            receipt({ id: 'a', location: 'e2e/one.e2e.ts:1:1', verdict: 'skipped' }),
            receipt({ durationMs: 700, id: 'b', location: 'e2e/one.e2e.ts:9:1' }),
        ]);

        expect(built.specs).toStrictEqual([
            expect.objectContaining({ durationMs: 700, path: 'e2e/one.e2e.ts' }),
        ]);
        expect(built.tests.every(({ durationMs }) => Number.isSafeInteger(durationMs))).toBe(true);
    });

    it('refuses a negative or fractional duration', () => {
        for (const durationMs of [-1, 1.5, NaN]) {
            expect(() =>
                assertE2EPoolReceipt({
                    ...pooled([receipt({ durationMs: 0 })]),
                    tests: [receipt({ durationMs })],
                }),
            ).toThrow('durations must be non-negative integers');
        }
    });
});

/**
 * Receipts are uploaded as CI artifacts and their spec paths reach the public job step summary, so an absolute path
 * would publish the runner's home directory and the account name inside it.
 */
describe('receipt paths', () => {
    const pooled = (tests: E2ETestReceipt[]) =>
        createE2EPoolReceipt({
            finishedAt: '2026-01-01T00:00:01.000Z',
            pool: 'parallel-safe',
            startedAt: '2026-01-01T00:00:00.000Z',
            tests,
        });

    it('refuses an absolute test location, artifact, or spec path', () => {
        const absoluteLocation = pooled([receipt()]);
        expect(() =>
            assertE2EPoolReceipt({
                ...absoluteLocation,
                tests: [receipt({ location: '/runner/work/caxri/e2e/example.e2e.ts:1:1' })],
            }),
        ).toThrow('paths must be repository-relative');
        expect(() =>
            assertE2EPoolReceipt({
                ...absoluteLocation,
                tests: [receipt({ artifacts: ['/runner/work/caxri/test-results/trace.zip'] })],
            }),
        ).toThrow('paths must be repository-relative');
        expect(() =>
            assertE2EPoolReceipt({
                ...absoluteLocation,
                specs: [
                    {
                        durationMs: 0,
                        path: '/runner/work/caxri/e2e/example.e2e.ts',
                        testIds: ['suite > case'],
                        verdict: 'pass',
                    },
                ],
            }),
        ).toThrow('paths must be repository-relative');
    });

    it('accepts the repository-relative paths the reporter writes', () => {
        expect(() =>
            assertE2EPoolReceipt(
                pooled([
                    receipt({
                        artifacts: ['test-results/parallel-safe/example/trace.zip'],
                        location: 'e2e/example.e2e.ts:1:1',
                    }),
                ]),
            ),
        ).not.toThrow();
    });
});
