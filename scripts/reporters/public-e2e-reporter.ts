import { isAbsolute, relative } from 'node:path';
import process from 'node:process';

import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import { readPublicE2EDiagnostics } from './public-e2e-diagnostics';

export const publicE2EReporterPath = './scripts/reporters/public-e2e-reporter.ts';
const e2eReceiptReporterPath = './scripts/reporters/e2e-receipt-reporter.ts';

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

function isCoordinate(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
}

/**
 * Playwright serializes ordinary assertion errors without a structured location. Only recover this spec's numbers.
 */
function stackFailureLocation(
    file: string,
    stack: string | undefined,
): { line: number; column: number } | undefined {
    const frames = stack?.split('\n', 100) ?? [];
    const prefix = `${file}:`;
    for (const frame of frames) {
        const text = frame.trim();
        if (!text.startsWith('at ')) continue;
        const index = text.indexOf(prefix, 3);
        const parenthesized = index > 3 && text[index - 1] === '(' && text.endsWith(')');
        if (index !== 3 && !parenthesized) continue;
        const coordinates = text.slice(index + prefix.length, parenthesized ? -1 : undefined);
        const match = /^(\d{1,7}):(\d{1,7})$/u.exec(coordinates);
        if (!match) continue;
        const line = Number(match[1]);
        const column = Number(match[2]);
        if (isCoordinate(line) && isCoordinate(column)) return { line, column };
    }
    return undefined;
}

/**
 * Only coordinates inside the current spec may leave the worker's error object. Never fall back to error text, source
 * snippets, or unrelated stack files, which can contain private workspace data.
 */
function failureLocation(
    test: TestCase,
    result: TestResult,
): { line: number; column: number } | undefined {
    for (const error of result.errors) {
        const location = error.location;
        if (
            location?.file === test.location.file &&
            isCoordinate(location.line) &&
            isCoordinate(location.column)
        )
            return { line: location.line, column: location.column };
        const stackLocation = stackFailureLocation(test.location.file, error.stack);
        if (stackLocation) return stackLocation;
    }
    return undefined;
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
        console.log(
            `CAXRI_E2E_PUBLIC ${JSON.stringify({
                durationMs,
                event: 'test-end',
                failureLocation: failureLocation(test, result),
                location: repoLocation(test),
                retry: result.retry,
                status: result.status,
                ...readPublicE2EDiagnostics(result.annotations),
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
