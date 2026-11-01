import { isAbsolute, relative } from 'node:path';
import process from 'node:process';

import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import { readPublicE2EDiagnostics } from './public-e2e-diagnostics';
import { classifyTestResult, specFailureLocation } from './public-e2e-failure-class';
import { readPublicE2ELaunch } from './public-e2e-launch';

type AttemptStatus = TestResult['status'];

const attemptStatuses = ['failed', 'interrupted', 'passed', 'skipped', 'timedOut'] as const;

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
 * failure messages, source snippets, titles, arbitrary annotations, attachments, steps, and DOM or Terminal values. The
 * public receipt retains the bounded failure classification used for diagnosis.
 */
class PublicE2EReporter implements Reporter {
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
        const failureClass = classifyTestResult(result, {
            file: test.location.file,
            launch: readPublicE2ELaunch(result.annotations),
            testTimeoutMs: test.timeout,
        });
        console.log(
            `CAXRI_E2E_PUBLIC ${JSON.stringify({
                durationMs,
                event: 'test-end',
                failureClass,
                failureLocation: specFailureLocation(test.location.file, result.errors),
                location: repoLocation(test),
                retry: result.retry,
                status: result.status,
                ...readPublicE2EDiagnostics(result.annotations),
            })}`,
        );
        // Playwright retries only after a failed attempt, so a passing retry is a flaky pass. Surface it on the run
        // summary instead of leaving the earlier failed attempt visible only in the step log (issue #1418).
        if (result.retry > 0 && result.status === 'passed')
            console.log(
                `::warning title=Flaky E2E pass::${repoLocation(test)} passed on retry ${result.retry} after a failed attempt`,
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
