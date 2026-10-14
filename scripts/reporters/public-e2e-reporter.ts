import { isAbsolute, relative } from 'node:path';
import process from 'node:process';

import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

export const publicE2EReporterPath = './scripts/reporters/public-e2e-reporter.ts';
export const e2eReceiptReporterPath = './scripts/reporters/e2e-receipt-reporter.ts';

type AttemptStatus = TestResult['status'];

const attemptStatuses = ['failed', 'interrupted', 'passed', 'skipped', 'timedOut'] as const;

export function shouldUsePublicE2EReporter(environment: NodeJS.ProcessEnv): boolean {
    const ci = environment.CI;
    return (
        environment.GITHUB_ACTIONS === 'true' ||
        (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false')
    );
}

export function playwrightReporterArgument(
    options: {
        environment?: NodeJS.ProcessEnv;
        includeReceipt?: boolean;
    } = {},
): string {
    const environment = options.environment ?? process.env;
    const reporters = [shouldUsePublicE2EReporter(environment) ? publicE2EReporterPath : 'line'];
    if (options.includeReceipt) reporters.push(e2eReceiptReporterPath);
    return `--reporter=${reporters.join(',')}`;
}

function repoLocation(test: TestCase): string {
    const file = relative(process.cwd(), test.location.file).replaceAll('\\', '/');
    const safeFile =
        file !== '' &&
        !isAbsolute(file) &&
        !file.split('/').includes('..') &&
        /^[a-z\d][\w./-]*$/iu.test(file)
            ? file
            : '<outside-repository>';
    return `${safeFile}:${test.location.line}:${test.location.column}`;
}

function emptyAttemptCounts(): Record<AttemptStatus, number> {
    return {
        failed: 0,
        interrupted: 0,
        passed: 0,
        skipped: 0,
        timedOut: 0,
    };
}

/**
 * CI reporter whose stdout is safe to expose from a public Actions run. It intentionally drops worker stdout/stderr,
 * failure messages, source snippets, titles, annotations, attachments, steps, and DOM or Terminal values. The public
 * receipt retains the bounded failure classification used for diagnosis.
 */
export class PublicE2EReporter implements Reporter {
    private attemptCounts = emptyAttemptCounts();
    private globalErrorCount = 0;
    private planned = 0;

    onBegin(_config: unknown, suite: Suite): void {
        this.planned = suite.allTests().length;
        console.log(
            `CAXRI_E2E_PUBLIC ${JSON.stringify({ event: 'begin', planned: this.planned })}`,
        );
    }

    onError(): void {
        this.globalErrorCount += 1;
    }

    onStdErr(): void {}

    onStdOut(): void {}

    onTestEnd(test: TestCase, result: TestResult): void {
        this.attemptCounts[result.status] += 1;
        const durationMs = Math.max(0, Math.round(result.duration));
        console.log(
            `CAXRI_E2E_PUBLIC ${JSON.stringify({
                durationMs,
                event: 'test-end',
                location: repoLocation(test),
                retry: result.retry,
                status: result.status,
            })}`,
        );
    }

    onEnd(result: FullResult): void {
        console.log(
            `CAXRI_E2E_PUBLIC ${JSON.stringify({
                attempts: this.attemptCounts,
                event: 'end',
                globalErrorCount: this.globalErrorCount,
                planned: this.planned,
                status: result.status,
            })}`,
        );
        for (const status of attemptStatuses) {
            const count = this.attemptCounts[status];
            if (count > 0) console.log(`${count} ${status}`);
        }
    }

    printsToStdio(): boolean {
        return true;
    }
}

export default PublicE2EReporter;
