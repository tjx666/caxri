import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

import type { FullConfig, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import { writeJsonAtomic } from '../atomic-json';

type E2ETestVerdict = 'fail' | 'pass' | 'skipped' | 'timeout' | 'unknown';

export interface E2ETestReceipt {
    artifacts: string[];
    /**
     * Wall-clock milliseconds Playwright attributes to this test, summed across retries. `0` for a test that never ran
     * (skipped or unknown), so the field is always a number and callers never special-case an absent duration.
     */
    durationMs: number;
    errorIdentity: string | null;
    /**
     * The first failed attempt of a test that Playwright retried, so a retry that ends green cannot erase the failure.
     * Only `e2e/startup.performance.e2e.ts` retries, and only in the Release pools (see that spec and issue #1418).
     */
    firstFailure?: { errorIdentity: string | null; verdict: 'fail' | 'timeout' };
    id: string;
    location: string;
    title: string;
    verdict: E2ETestVerdict;
}

interface E2ESpecReceipt {
    /**
     * Sum of this spec's test durations. Playwright charges fixture setup, including the Electron launch, to the test
     * that triggered it, so this is the spec's true cost in its pool and is what pool-balancing decisions should read.
     */
    durationMs: number;
    path: string;
    testIds: string[];
    verdict: 'fail' | 'pass' | 'timeout' | 'unknown';
}

export interface E2EFailureGroup {
    count: number;
    identity: string;
    testIds: string[];
}

/**
 * One Playwright child process that exited non-zero. Recorded on the pool receipt so the reason a pool failed survives
 * in the artifact even when every test it did report passed.
 */
export interface E2EAbortedInvocation {
    exitCode: number;
    specs: string[];
}

/**
 * Why `run-e2e-pools.ts` stopped an invocation loop before every planned invocation ran. Closed so a consumer of the
 * receipt never has to guess at a free-text reason: `ci-concurrent-validation.ts` sends `SIGTERM` to every sibling
 * process group when a component fails or the shared execution deadline expires (see AGENTS.md and
 * `scripts/ci-concurrent-validation.ts`); a workflow cancellation delivers `SIGINT` first. See issue #1446.
 */
export type E2EPoolAbortReason = 'SIGINT' | 'SIGTERM';

export interface E2EPoolReceipt {
    /**
     * Present only on the final pool receipt, and only when a child exited non-zero.
     */
    abortedInvocations?: E2EAbortedInvocation[];
    /**
     * Present only when an external signal stopped the pool before every invocation finished. `status` is always
     * `failed` when this is set, even if every invocation that did run happened to pass, an aborted pool never finished
     * planning its own completeness.
     */
    abortReason?: E2EPoolAbortReason;
    failed: number;
    failureGroups: E2EFailureGroup[];
    finished: number;
    finishedAt: string;
    hash: string;
    /**
     * Dispatched spec files the reporter never saw; present only on the final pool receipt.
     */
    missingSpecs?: string[];
    passed: number;
    planned: number;
    pool: string;
    skipped: number;
    specs: E2ESpecReceipt[];
    started: number;
    startedAt: string;
    status: 'failed' | 'passed';
    tests: E2ETestReceipt[];
    timedOut: number;
    unknown: number;
}

const projectRoot = resolve(import.meta.dirname, '../..');

/**
 * Rewrites a path Playwright reports in absolute form to a repository-relative one.
 *
 * Receipts are uploaded as CI artifacts and their spec paths are printed into the job's step summary, so an absolute
 * path would publish the runner's home directory and the account name inside it. Relative paths also make a receipt
 * comparable between the runner and a local checkout, which is what the pool and manifest comparisons assume.
 */
function repoRelative(path: string): string {
    return isAbsolute(path) ? relative(projectRoot, path) : path;
}

function specPath(location: string): string {
    return location.replace(/:\d+:\d+$/u, '');
}

function normalizeError(error: string): string {
    return error
        .replaceAll(String.fromCodePoint(27), '')
        .replaceAll(/\[[0-9;]*m/gu, '')
        .replaceAll(/\/var\/folders\/[^\s)]+/gu, '<tmp>')
        .replaceAll(/\/private\/tmp\/[^\s)]+/gu, '<tmp>')
        .replaceAll(/:\d+:\d+/gu, ':<line>:<column>')
        .trim();
}

export function stableErrorIdentity(error: string): string {
    return createHash('sha256').update(normalizeError(error)).digest('hex');
}

export function summarizeE2ETests(tests: readonly E2ETestReceipt[]): string {
    return createHash('sha256')
        .update(
            JSON.stringify(
                [...tests]
                    .toSorted((left, right) => left.id.localeCompare(right.id))
                    .map(({ id, location, title }) => ({ id, location, title })),
            ),
        )
        .digest('hex');
}

function summarizeSpecs(tests: readonly E2ETestReceipt[]): E2ESpecReceipt[] {
    const grouped = new Map<string, E2ETestReceipt[]>();
    for (const test of tests) {
        const path = specPath(test.location);
        grouped.set(path, [...(grouped.get(path) ?? []), test]);
    }
    return [...grouped]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([path, specTests]) => ({
            durationMs: specTests.reduce((total, { durationMs }) => total + durationMs, 0),
            path,
            testIds: specTests
                .map(({ id }) => id)
                .toSorted((left, right) => left.localeCompare(right)),
            verdict: specTests.some(({ verdict }) => verdict === 'unknown')
                ? 'unknown'
                : specTests.some(({ verdict }) => verdict === 'timeout')
                  ? 'timeout'
                  : specTests.some(({ verdict }) => verdict === 'fail')
                    ? 'fail'
                    : 'pass',
        }));
}

function summarizeFailureGroups(tests: readonly E2ETestReceipt[]): E2EFailureGroup[] {
    const grouped = new Map<string, string[]>();
    for (const test of tests) {
        if (!test.errorIdentity) continue;
        grouped.set(test.errorIdentity, [...(grouped.get(test.errorIdentity) ?? []), test.id]);
    }
    return [...grouped]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([identity, testIds]) => ({
            count: testIds.length,
            identity,
            testIds: testIds.toSorted((left, right) => left.localeCompare(right)),
        }));
}

export function createE2EPoolReceipt(input: {
    finishedAt: string;
    pool: string;
    startedAt: string;
    tests: E2ETestReceipt[];
}): E2EPoolReceipt {
    const passed = input.tests.filter(({ verdict }) => verdict === 'pass').length;
    const skipped = input.tests.filter(({ verdict }) => verdict === 'skipped').length;
    const timedOut = input.tests.filter(({ verdict }) => verdict === 'timeout').length;
    const failed = input.tests.filter(({ verdict }) => verdict === 'fail').length;
    const unknown = input.tests.filter(({ verdict }) => verdict === 'unknown').length;
    const finished = passed + skipped + timedOut + failed;
    const receipt: E2EPoolReceipt = {
        failed,
        failureGroups: summarizeFailureGroups(input.tests),
        finished,
        finishedAt: input.finishedAt,
        hash: summarizeE2ETests(input.tests),
        passed,
        planned: input.tests.length,
        pool: input.pool,
        skipped,
        specs: summarizeSpecs(input.tests),
        started: input.tests.filter(({ verdict }) => !['skipped', 'unknown'].includes(verdict))
            .length,
        startedAt: input.startedAt,
        status: failed + timedOut + unknown === 0 ? 'passed' : 'failed',
        tests: input.tests,
        timedOut,
        unknown,
    };
    assertE2EPoolReceipt(receipt);
    return receipt;
}

/**
 * Rejects truncated or internally inconsistent receipts before they can satisfy CI evidence.
 */
export function assertE2EPoolReceipt(receipt: E2EPoolReceipt): void {
    const counts = [
        receipt.failed,
        receipt.finished,
        receipt.passed,
        receipt.planned,
        receipt.skipped,
        receipt.started,
        receipt.timedOut,
        receipt.unknown,
    ];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error(`E2E ${receipt.pool} receipt counts must be non-negative integers`);
    }
    if (receipt.tests.length !== receipt.planned) {
        throw new Error(`E2E ${receipt.pool} receipt test list does not match its planned count`);
    }
    if (receipt.passed + receipt.skipped + receipt.failed + receipt.timedOut !== receipt.finished) {
        throw new Error(`E2E ${receipt.pool} receipt outcomes do not match its finished count`);
    }
    if (receipt.finished + receipt.unknown !== receipt.planned) {
        throw new Error(`E2E ${receipt.pool} receipt does not classify every planned test`);
    }
    if (receipt.started > receipt.planned || receipt.finished > receipt.planned) {
        throw new Error(`E2E ${receipt.pool} receipt execution exceeds its planned count`);
    }
    if (receipt.specs.some(({ verdict }) => verdict === 'unknown') !== receipt.unknown > 0) {
        throw new Error(`E2E ${receipt.pool} spec census disagrees with its test verdicts`);
    }
    if (
        [...receipt.tests, ...receipt.specs].some(
            ({ durationMs }) => !Number.isSafeInteger(durationMs) || durationMs < 0,
        )
    ) {
        throw new Error(`E2E ${receipt.pool} receipt durations must be non-negative integers`);
    }
    /**
     * A receipt is uploaded as a CI artifact and its spec paths are printed into the job's step summary, so an absolute
     * path would publish the runner's home directory and the account name inside it.
     */
    if (
        [
            ...receipt.tests.flatMap(({ artifacts, location }) => [location, ...artifacts]),
            ...receipt.specs.map(({ path }) => path),
        ].some((path) => isAbsolute(path))
    ) {
        throw new Error(`E2E ${receipt.pool} receipt paths must be repository-relative`);
    }
    if (
        receipt.status === 'passed' &&
        (receipt.unknown !== 0 ||
            receipt.failed !== 0 ||
            receipt.timedOut !== 0 ||
            receipt.abortReason !== undefined ||
            (receipt.abortedInvocations?.length ?? 0) > 0 ||
            (receipt.missingSpecs?.length ?? 0) > 0)
    ) {
        throw new Error(`E2E ${receipt.pool} passing receipt is incomplete`);
    }
}

export function assertE2EPoolCensusComplete(receipt: E2EPoolReceipt): void {
    assertE2EPoolReceipt(receipt);
    if (receipt.unknown > 0 || receipt.specs.some(({ verdict }) => verdict === 'unknown')) {
        throw new Error(`E2E ${receipt.pool} failure census left suppressed or unknown tests`);
    }
}

/**
 * Sidecar journal the reporter appends to as each test settles, beside the invocation receipt. `onEnd` never runs when
 * `ci-concurrent-validation.ts` signals the Playwright process group mid-invocation, so without this journal the killed
 * invocation's receipt is missing and every verdict it already settled, failures included, is lost (issue #1847).
 */
export function e2eProgressJournalPath(receiptPath: string): string {
    return `${receiptPath}.progress.jsonl`;
}

type E2EProgressEntry =
    | { startedAt: string; tests: E2ETestReceipt[]; type: 'begin' }
    | { test: E2ETestReceipt; type: 'end' };

/**
 * Rebuilds a partial invocation receipt from a progress journal whose invocation died before `onEnd`. Only specs with
 * at least one settled test are kept, so a spec the invocation never reached stays absent and the pool runner still
 * reports it in `missingSpecs`; a test still running in a reached spec stays `unknown`. A torn trailing line (the kill
 * landed mid-append) is ignored. Returns `undefined` when the journal never recorded `onBegin`.
 */
export function receiptFromProgressJournal(
    journal: string,
    pool: string,
    finishedAt: string,
): E2EPoolReceipt | undefined {
    const entries: E2EProgressEntry[] = [];
    const lines = journal.split('\n').filter((line) => line.trim() !== '');
    for (const [index, line] of lines.entries()) {
        try {
            entries.push(JSON.parse(line) as E2EProgressEntry);
        } catch (error) {
            if (index === lines.length - 1) break;
            throw error;
        }
    }
    const begin = entries.find((entry) => entry.type === 'begin');
    if (!begin) return undefined;
    const tests = new Map(begin.tests.map((test) => [test.id, test]));
    const reachedSpecs = new Set<string>();
    for (const entry of entries) {
        if (entry.type !== 'end' || !tests.has(entry.test.id)) continue;
        tests.set(entry.test.id, entry.test);
        reachedSpecs.add(specPath(entry.test.location));
    }
    return createE2EPoolReceipt({
        finishedAt,
        pool,
        startedAt: begin.startedAt,
        tests: tests
            .values()
            .filter(({ location }) => reachedSpecs.has(specPath(location)))
            .toArray(),
    });
}

/**
 * Records one logical pool from the same invocation that executes its tests.
 */
class E2EReceiptReporter implements Reporter {
    private planned = new Map<string, E2ETestReceipt>();
    private progressPath: string | undefined;
    private startedAt = '';

    /**
     * Synchronous on purpose: the kernel keeps an appended line even if the process is `SIGKILL`ed right after, while
     * an async write still queued in the event loop would be lost with it.
     */
    private appendProgress(entry: E2EProgressEntry): void {
        if (!this.progressPath) return;
        // oxlint-disable-next-line node/no-sync -- must reach the kernel before a signal can kill this process; see JSDoc
        appendFileSync(this.progressPath, `${JSON.stringify(entry)}\n`, 'utf8');
    }

    onBegin(_config: FullConfig, suite: Suite): void {
        this.startedAt = new Date().toISOString();
        this.planned = new Map(
            suite.allTests().map((test) => [
                test.id,
                {
                    artifacts: [],
                    durationMs: 0,
                    errorIdentity: null,
                    id: test.id,
                    location: `${repoRelative(test.location.file)}:${test.location.line}:${test.location.column}`,
                    title: test.titlePath().slice(1).join(' › '),
                    verdict: test.expectedStatus === 'skipped' ? 'skipped' : 'unknown',
                },
            ]),
        );
        const destination = process.env.CAXRI_E2E_RECEIPT_PATH;
        if (!destination) return;
        this.progressPath = e2eProgressJournalPath(resolve(destination));
        // Playwright calls `onBegin` synchronously, and the journal must exist before the first `onTestEnd` appends.
        // oxlint-disable-next-line node/no-sync -- see the comment above
        mkdirSync(dirname(this.progressPath), { recursive: true });
        // oxlint-disable-next-line node/no-sync -- see the comment above
        writeFileSync(this.progressPath, '', 'utf8');
        this.appendProgress({
            startedAt: this.startedAt,
            tests: this.planned.values().toArray(),
            type: 'begin',
        });
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        const planned = this.planned.get(test.id);
        if (!planned) return;
        const error = result.error?.message ?? result.errors[0]?.message;
        // Retries replay the same test id, so accumulate rather than overwrite: the pool really did spend both attempts.
        planned.durationMs += Math.max(0, Math.round(result.duration));
        planned.artifacts = result.attachments
            .map(({ path }) => path)
            .filter((path): path is string => Boolean(path))
            .map((path) => repoRelative(path));
        /**
         * An interrupted test has no independent outcome; the failure census must run it.
         */
        if (result.status === 'interrupted') {
            planned.errorIdentity = null;
            planned.verdict = 'unknown';
            this.appendProgress({ test: planned, type: 'end' });
            return;
        }
        if (
            result.retry > 0 &&
            !planned.firstFailure &&
            (planned.verdict === 'fail' || planned.verdict === 'timeout')
        )
            planned.firstFailure = {
                errorIdentity: planned.errorIdentity,
                verdict: planned.verdict,
            };
        planned.errorIdentity = error ? stableErrorIdentity(error) : null;
        planned.verdict =
            result.status === 'passed'
                ? 'pass'
                : result.status === 'timedOut'
                  ? 'timeout'
                  : result.status === 'skipped'
                    ? test.expectedStatus === 'skipped'
                        ? 'skipped'
                        : 'unknown'
                    : 'fail';
        this.appendProgress({ test: planned, type: 'end' });
    }

    async onEnd(): Promise<void> {
        const pool = process.env.CAXRI_E2E_POOL;
        const destination = process.env.CAXRI_E2E_RECEIPT_PATH;
        if (!pool || !destination) {
            throw new Error(
                'CAXRI_E2E_POOL and CAXRI_E2E_RECEIPT_PATH are required for E2E receipts',
            );
        }
        const receipt = createE2EPoolReceipt({
            finishedAt: new Date().toISOString(),
            pool,
            startedAt: this.startedAt,
            tests: this.planned.values().toArray(),
        });
        const output = resolve(destination);
        await writeJsonAtomic(output, receipt, { ensureParent: true });
        // The complete receipt supersedes the journal; removing it keeps a stale journal from ever being read.
        await rm(e2eProgressJournalPath(output), { force: true });
    }
}

export default E2EReceiptReporter;
