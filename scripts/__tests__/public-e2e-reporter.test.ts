import { join } from 'node:path';
import process from 'node:process';

import { logEventNames } from '@caxri/protocol';
import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    annotateE2EGateFailure,
    annotateE2ETimings,
    readPublicE2EDiagnostics,
} from '../reporters/public-e2e-diagnostics';
import PublicE2EReporter from '../reporters/public-e2e-reporter';
import {
    playwrightReporterArgument,
    publicE2EReporterPath,
    shouldUsePublicE2EReporter,
} from '../reporters/public-e2e-reporter-policy';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('public E2E reporter policy', () => {
    it.each(['cleanup-failed', 'capture-failed'])(
        'publishes the fixed %s fixture phase without the failure text',
        (phase) => {
            const diagnostics = readPublicE2EDiagnostics([
                {
                    type: 'caxri-public-error-gate',
                    description: JSON.stringify({ phase, message: 'private fixture failure' }),
                },
            ]);
            expect(diagnostics.gateFailures?.[0]?.phase).toBe(phase);
            expect(JSON.stringify(diagnostics)).not.toContain('private');
        },
    );

    it('retains a large valid allowance count through worker and reporter validation', () => {
        const info = { annotations: [] as Array<{ type: string; description?: string }> };
        annotateE2EGateFailure(
            info,
            'policy-rejected',
            [],
            [{ source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 2_000_000 }],
        );
        const expected = readPublicE2EDiagnostics(info.annotations).gateFailures?.[0]?.expected;
        expect(expected?.total).toBe(2_000_000);
        expect(expected?.groups[0]?.count).toBe(2_000_000);
    });

    it('publishes fixed phases, protocol error counts, and numeric timing checkpoints without worker content', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const reporter = new PublicE2EReporter();
        const info = { annotations: [] as Array<{ type: string; description?: string }> };
        annotateE2EGateFailure(info, 'policy-rejected', [
            {
                source: 'server-core',
                event: 'ipc.request_failed',
                code: 'GIT',
                method: 'git.pullRequestChanges',
            },
            {
                source: 'server-core',
                event: 'ipc.request_failed',
                code: 'GIT',
                method: 'git.pullRequestChanges',
            },
        ]);
        annotateE2ETimings(info, 'coldLaunch', { electronLaunchMs: 3001.234, freshnessMs: 2 });
        annotateE2ETimings(info, 'benchmark', {
            runtimeReadyMs: 3456,
            executable: '/private/application',
            sessionRoot: '/private/project',
            terminalEchoMs: Infinity,
        });
        expect(JSON.stringify(info.annotations)).not.toContain('/private/');
        reporter.onTestEnd(
            {
                location: { file: join(process.cwd(), 'e2e/example.e2e.ts'), line: 1, column: 1 },
            } as TestCase,
            {
                annotations: info.annotations,
                duration: 5,
                errors: [],
                retry: 0,
                status: 'failed',
            } as unknown as TestResult,
        );
        const output = log.mock.calls.flat().join('\n');
        expect(output).toContain('"phase":"policy-rejected"');
        expect(output).toContain('"method":"git.pullRequestChanges","count":2');
        expect(output).toContain('"coldLaunch":{"freshnessMs":2,"electronLaunchMs":3001.23}');
        expect(output).toContain('"runtimeReadyMs":3456');
        expect(output).not.toContain('private');
        expect(output).not.toContain('terminalEchoMs');
    });

    it('revalidates dedicated annotations and collapses unknown error strings without exposing them', () => {
        const result = readPublicE2EDiagnostics([
            {
                type: 'caxri-public-error-gate',
                description: JSON.stringify({
                    phase: 'policy-rejected',
                    actual: [
                        {
                            source: 'private source',
                            event: 'private event',
                            code: 'private code',
                            method: 'private method',
                            count: 1,
                            message: 'private message',
                        },
                    ],
                }),
            },
            { type: 'caxri-public-error-gate', description: '{"phase":"private phase"}' },
            { type: 'caxri-public-error-gate', description: 'not json: private text' },
            {
                type: 'caxri-public-timings',
                description: JSON.stringify({
                    scope: 'benchmark',
                    values: {
                        runtimeReadyMs: -1,
                        filesReadyMs: 600_001,
                        gitReadyMs: 'private value',
                        terminalReadyMs: 50,
                        privateField: 1,
                    },
                }),
            },
            {
                type: 'caxri-public-timings',
                description: '{"scope":"__proto__","values":{"runtimeReadyMs":1}}',
            },
            { type: 'private annotation', description: '{"runtimeReadyMs":1}' },
        ]);
        expect(result.gateFailures?.[0]?.actual.groups).toEqual([
            { source: 'other', event: 'other', code: 'other', count: 1 },
        ]);
        expect(result.gateFailures).toHaveLength(1);
        expect(result.timings).toEqual({ benchmark: { terminalReadyMs: 50 } });
        expect(JSON.stringify(result)).not.toContain('private');
        expect(JSON.stringify(result)).not.toContain('__proto__');
    });

    it('retains total error volume when public group details are capped', () => {
        const info = { annotations: [] as Array<{ type: string; description?: string }> };
        annotateE2EGateFailure(
            info,
            'policy-rejected',
            logEventNames
                .slice(0, 101)
                .map((event) => ({ source: 'server-core', event, code: 'INTERNAL' })),
        );
        const actual = readPublicE2EDiagnostics(info.annotations).gateFailures?.[0]?.actual;
        expect(actual?.total).toBe(101);
        expect(actual?.groups).toHaveLength(100);
        expect(actual?.omittedGroups).toBe(1);
    });

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
            errors: [],
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
        const result = {
            duration: 1,
            errors: [],
            retry: 0,
            status: 'passed',
        } as unknown as TestResult;

        reporter.onTestEnd(test, result);

        const output = log.mock.calls.flat().join('\n');
        expect(output).toContain('<outside-repository>:1:1');
        expect(output).not.toContain('/private/secret.e2e.ts');
    });

    it('reports only failure coordinates from the current spec', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const reporter = new PublicE2EReporter();
        const file = join(process.cwd(), 'e2e/example.e2e.ts');
        const test = { location: { column: 2, file, line: 12 } } as TestCase;
        const result = {
            duration: 1,
            errors: [
                {
                    location: { column: 9, file, line: 44 },
                    message: 'private assertion values',
                    snippet: 'private source',
                    stack: 'private stack',
                },
            ],
            retry: 0,
            status: 'failed',
        } as TestResult;

        reporter.onTestEnd(test, result);

        const output = log.mock.calls.flat().join('\n');
        expect(output).toContain('"failureLocation":{"line":44,"column":9}');
        expect(output).not.toContain('private');
        expect(output).not.toContain(process.cwd());
    });

    it('finds current-spec coordinates in ordinary assertion stacks without publishing the stack', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const reporter = new PublicE2EReporter();
        const file = join(process.cwd(), 'e2e/example.e2e.ts');
        const test = { location: { column: 2, file, line: 12 } } as TestCase;
        const result = {
            duration: 1,
            errors: [
                {
                    message: 'private assertion values',
                    stack: `Error: private assertion values\n    at helper (/private/other.ts:1:1)\n    at Object.run (${file}:48:13)`,
                },
            ],
            retry: 0,
            status: 'failed',
        } as TestResult;

        reporter.onTestEnd(test, result);

        const output = log.mock.calls.flat().join('\n');
        expect(output).toContain('"failureLocation":{"line":48,"column":13}');
        expect(output).not.toContain('private');
        expect(output).not.toContain('Object.run');
        expect(output).not.toContain(process.cwd());
    });

    it.each([
        undefined,
        { file: '/private/other.e2e.ts', line: 44, column: 9 },
        { file: join(process.cwd(), 'e2e/other.e2e.ts'), line: 44, column: 9 },
        { file: join(process.cwd(), 'e2e/example.e2e.ts'), line: 0, column: 9 },
        { file: join(process.cwd(), 'e2e/example.e2e.ts'), line: 44, column: 1.5 },
        { file: join(process.cwd(), 'e2e/example.e2e.ts'), line: 1_000_001, column: 9 },
    ])('omits untrusted failure coordinates (%j)', (location) => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const reporter = new PublicE2EReporter();
        const test = {
            location: { column: 2, file: join(process.cwd(), 'e2e/example.e2e.ts'), line: 12 },
        } as TestCase;
        const result = {
            duration: 1,
            errors: [{ location, message: 'private assertion', stack: 'private stack' }],
            retry: 0,
            status: 'failed',
        } as TestResult;

        reporter.onTestEnd(test, result);

        const output = log.mock.calls.flat().join('\n');
        expect(output).not.toContain('failureLocation');
        expect(output).not.toContain('private');
        expect(output).not.toContain(process.cwd());
    });
});
