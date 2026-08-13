import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
    FullConfig,
    FullResult,
    Reporter,
    Suite,
    TestCase,
    TestResult,
} from '@playwright/test/reporter';

export interface E2ETestReceipt {
    id: string;
    location: string;
    title: string;
}

export interface E2EPoolReceipt {
    failed: number;
    finished: number;
    finishedAt: string;
    hash: string;
    passed: number;
    planned: number;
    pool: string;
    skipped: number;
    started: number;
    startedAt: string;
    status: 'failed' | 'passed';
    tests: E2ETestReceipt[];
}

export function summarizeE2ETests(tests: readonly E2ETestReceipt[]): string {
    return createHash('sha256')
        .update(JSON.stringify([...tests].sort((left, right) => left.id.localeCompare(right.id))))
        .digest('hex');
}

/** Rejects truncated or internally inconsistent receipts before they can satisfy CI evidence. */
export function assertE2EPoolReceipt(receipt: E2EPoolReceipt): void {
    const counts = [
        receipt.failed,
        receipt.finished,
        receipt.passed,
        receipt.planned,
        receipt.skipped,
        receipt.started,
    ];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error(`E2E ${receipt.pool} receipt counts must be non-negative integers`);
    }
    if (receipt.tests.length !== receipt.planned) {
        throw new Error(`E2E ${receipt.pool} receipt test list does not match its planned count`);
    }
    if (receipt.passed + receipt.skipped + receipt.failed !== receipt.finished) {
        throw new Error(`E2E ${receipt.pool} receipt outcomes do not match its finished count`);
    }
    if (receipt.started > receipt.planned || receipt.finished > receipt.planned) {
        throw new Error(`E2E ${receipt.pool} receipt execution exceeds its planned count`);
    }
    if (
        receipt.status === 'passed' &&
        (receipt.finished !== receipt.planned || receipt.failed !== 0)
    ) {
        throw new Error(`E2E ${receipt.pool} passing receipt is incomplete`);
    }
}

/** Records one logical pool from the same invocation that executes its tests. */
class E2EReceiptReporter implements Reporter {
    private failed = 0;
    private finished = 0;
    private passed = 0;
    private planned: E2ETestReceipt[] = [];
    private skipped = 0;
    private started = 0;
    private startedAt = '';

    onBegin(_config: FullConfig, suite: Suite): void {
        this.startedAt = new Date().toISOString();
        this.planned = suite.allTests().map((test) => ({
            id: test.id,
            location: `${test.location.file}:${test.location.line}:${test.location.column}`,
            title: test.titlePath().slice(1).join(' › '),
        }));
    }

    onTestBegin(): void {
        this.started += 1;
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        void test;
        this.finished += 1;
        if (result.status === 'passed') this.passed += 1;
        else if (result.status === 'skipped') this.skipped += 1;
        else this.failed += 1;
    }

    async onEnd(result: FullResult): Promise<void> {
        const pool = process.env.CAXRI_E2E_POOL;
        const destination = process.env.CAXRI_E2E_RECEIPT_PATH;
        if (!pool || !destination) {
            throw new Error(
                'CAXRI_E2E_POOL and CAXRI_E2E_RECEIPT_PATH are required for E2E receipts',
            );
        }
        const receipt: E2EPoolReceipt = {
            failed: this.failed,
            finished: this.finished,
            finishedAt: new Date().toISOString(),
            hash: summarizeE2ETests(this.planned),
            passed: this.passed,
            planned: this.planned.length,
            pool,
            skipped: this.skipped,
            started: this.started,
            startedAt: this.startedAt,
            status: result.status === 'passed' ? 'passed' : 'failed',
            tests: this.planned,
        };
        assertE2EPoolReceipt(receipt);
        const output = resolve(destination);
        await mkdir(dirname(output), { recursive: true });
        const temporary = `${output}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        await rename(temporary, output);
    }
}

export default E2EReceiptReporter;
