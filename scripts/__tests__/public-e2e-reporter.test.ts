import { join } from 'node:path';
import process from 'node:process';

import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PublicE2EReporter, {
    playwrightReporterArgument,
    publicE2EReporterPath,
    shouldUsePublicE2EReporter,
} from '../reporters/public-e2e-reporter';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('public E2E reporter policy', () => {
    it('uses the content-safe reporter only for CI and preserves local line output', () => {
        expect(shouldUsePublicE2EReporter({})).toBe(false);
        expect(playwrightReporterArgument({ environment: {} })).toBe('--reporter=line');
        expect(playwrightReporterArgument({ environment: { CI: 'true' } })).toBe(
            `--reporter=${publicE2EReporterPath}`,
        );
        expect(
            playwrightReporterArgument({
                environment: { GITHUB_ACTIONS: 'true' },
                includeReceipt: true,
            }),
        ).toBe(
            '--reporter=./scripts/reporters/public-e2e-reporter.ts,./scripts/reporters/e2e-receipt-reporter.ts',
        );
    });

    it('prints only bounded metadata and discards error, source, DOM, Terminal, and worker output', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const reporter = new PublicE2EReporter();
        const test = {
            location: {
                column: 2,
                file: join(process.cwd(), 'e2e/example.e2e.ts'),
                line: 12,
            },
            title: 'private source title',
        } as unknown as TestCase;
        const result = {
            annotations: [{ description: 'private annotation' }],
            attachments: [{ body: 'private attachment' }],
            duration: 12.4,
            error: { message: 'private DOM and Terminal output' },
            retry: 0,
            status: 'failed',
            stderr: ['private stderr'],
            stdout: ['private stdout'],
        } as unknown as TestResult;
        const asReporter: Reporter = reporter;

        reporter.onBegin({}, { allTests: () => [test] } as unknown as Suite);
        asReporter.onStdOut?.('private stdout', test, result);
        asReporter.onStdErr?.('private stderr', test, result);
        asReporter.onError?.({ message: 'private global source snippet' });
        reporter.onTestEnd(test, result);
        reporter.onEnd({ status: 'failed' } as FullResult);

        const output = log.mock.calls.flat().join('\n');
        expect(output).toContain('e2e/example.e2e.ts:12:2');
        expect(output).toContain('"globalErrorCount":1');
        expect(output).toContain('1 failed');
        for (const forbidden of [
            process.cwd(),
            'private source title',
            'private DOM and Terminal output',
            'private stdout',
            'private stderr',
            'private global source snippet',
            'private annotation',
            'private attachment',
        ]) {
            expect(output).not.toContain(forbidden);
        }
        expect(reporter.printsToStdio()).toBe(true);
    });

    it('replaces an outside-repository source location with a closed sentinel', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const reporter = new PublicE2EReporter();
        const test = {
            location: { column: 1, file: '/private/secret.e2e.ts', line: 1 },
        } as TestCase;
        const result = { duration: 1, retry: 0, status: 'passed' } as TestResult;

        reporter.onTestEnd(test, result);

        const output = log.mock.calls.flat().join('\n');
        expect(output).toContain('<outside-repository>:1:1');
        expect(output).not.toContain('/private/secret.e2e.ts');
    });
});
