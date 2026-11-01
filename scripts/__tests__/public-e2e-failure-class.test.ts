import { join } from 'node:path';
import process from 'node:process';

import type { TestCase, TestResult } from '@playwright/test/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { FailureClassContext } from '../reporters/public-e2e-failure-class';
import {
    bucketTimeoutMs,
    classifyE2EFailure,
    classifyTestResult,
    primaryErrorMessage,
    publicE2EFailureClassSchema,
} from '../reporters/public-e2e-failure-class';
import {
    annotateE2ELaunch,
    readPublicE2ELaunch,
    safeProcessExit,
} from '../reporters/public-e2e-launch';
import PublicE2EReporter from '../reporters/public-e2e-reporter';

const specFile = join(process.cwd(), 'e2e/example.e2e.ts');
const sentinel = 'SENTINEL_PRIVATE_TEXT';
const privateRoot = '/Users/private/secret-project';
const esc = String.fromCodePoint(27);
const dim = (text: string) => `${esc}[2m${text}${esc}[22m`;
const red = (text: string) => `${esc}[31m${text}${esc}[39m`;

function context(overrides: Partial<FailureClassContext> = {}): FailureClassContext {
    return { file: specFile, status: 'failed', testTimeoutMs: 120_000, ...overrides };
}

function stack(...frames: string[]): string {
    return [`Error: ${sentinel}`, ...frames.map((frame) => `    at ${frame}`)].join('\n');
}

/**
 * Shapes copied from the Playwright matcher templates (`formatMatcherMessage`), with private text in every slot a user
 * or runner controls.
 */
const fixtures = {
    locatorMissing: [
        `${dim('expect(')}${red('locator')}${dim(').')}toBeVisible${dim('(')}${dim(')')} failed`,
        '',
        `Locator:  getByRole('button', { name: '${sentinel}' })`,
        'Expected: visible',
        'Received: <element(s) not found>',
        'Timeout:  5000ms',
        '',
        'Call log:',
        `  - waiting for getByRole('button', { name: '${sentinel}' }) in ${privateRoot}`,
    ].join('\n'),
    locatorText: [
        'expect(locator).not.toHaveText(expected) failed',
        '',
        `Locator: getByTestId('${sentinel}').getByText('${sentinel}')`,
        `Expected string: "${sentinel}"`,
        `Received string: "${sentinel} ${privateRoot}"`,
        'Timeout: 7000ms',
    ].join('\n'),
    valueMismatch: [
        'expect(received).toBe(expected) // Object.is equality',
        '',
        `Expected: "${sentinel}"`,
        `Received: "${privateRoot}"`,
    ].join('\n'),
    pollTimeout: [
        'expect(received).toBeTruthy()',
        '',
        'Expected: truthy',
        `Received: ${sentinel}`,
        '',
        'Call Log:',
        '- Timeout 10000ms exceeded while waiting on the predicate',
    ].join('\n'),
    actionTimeout: [
        'locator.click: Timeout 15000ms exceeded.',
        'Call log:',
        `  - waiting for locator('textarea.${sentinel}')`,
    ].join('\n'),
    testTimeout: 'Test timeout of 120000ms exceeded.',
    targetClosed: `page.evaluate: Target page, context or browser has been closed ${sentinel}`,
    launch: `electron.launch: Process failed to launch! ${privateRoot} ${sentinel}`,
};

describe('classifyE2EFailure', () => {
    it('classifies a missing locator without carrying the locator text', () => {
        const helperFile = join(process.cwd(), 'e2e/support/helpers.ts');
        const failure = classifyE2EFailure(
            [
                {
                    message: fixtures.locatorMissing,
                    stack: stack(
                        `Object.<anonymous> (${specFile}:42:7)`,
                        `async helper (${helperFile}:10:2)`,
                        `async x (${privateRoot}/node_modules/playwright/index.js:1:1)`,
                    ),
                },
            ],
            context(),
        );
        expect(failure).toMatchObject({
            frames: ['e2e/example.e2e.ts:42', 'e2e/support/helpers.ts:10'],
            kind: 'assertion-timeout',
            locationSource: 'spec',
            locatorKind: 'role',
            matcher: 'toBeVisible',
            negated: false,
            receiver: 'locator',
            received: 'not-found',
            timeoutMs: 5000,
        });
        expect(JSON.stringify(failure)).not.toContain(sentinel);
        expect(JSON.stringify(failure)).not.toContain('private');
    });

    it('records how a locator resolved and the numbers of a finite numeric mismatch, never text', () => {
        const classify = (message: string) =>
            classifyE2EFailure([{ message }], context({ testTimeoutMs: 120_000 }));
        expect(
            classify(
                [
                    'expect(received).toBeCloseTo(expected, precision)',
                    '',
                    'Expected: 492',
                    'Received: 486.5',
                    '',
                    'Expected precision:    0',
                ].join('\n'),
            ),
        ).toMatchObject({ matcher: 'toBeCloseTo', numbers: { expected: 492, received: 486.5 } });
        expect(
            classify(
                [
                    'expect(locator).toHaveCount(expected) failed',
                    '',
                    `Locator: locator('.${sentinel}')`,
                    'Expected: 0',
                    'Received: 1',
                    'Timeout: 15000ms',
                ].join('\n'),
            ),
        ).toMatchObject({
            numbers: { expected: 0, received: 1 },
            received: 'wrong-count',
            timeoutMs: 15_000,
        });
        expect(
            classify(
                [
                    'expect(locator).toBeVisible() failed',
                    '',
                    `Locator: getByText('${sentinel}')`,
                    'Expected: visible',
                    'Received: hidden',
                    'Timeout: 5000ms',
                ].join('\n'),
            ),
        ).toMatchObject({ received: 'hidden' });
        expect(
            classify(
                [
                    'expect(locator).toBeVisible() failed',
                    '',
                    `Locator: getByText('${sentinel}')`,
                    `Error: strict mode violation: getByText('${sentinel}') resolved to 2 elements`,
                    'Timeout: 5000ms',
                ].join('\n'),
            ),
        ).toMatchObject({ received: 'wrong-count' });
        expect(
            classify(
                [
                    'expect(locator).toBeVisible() failed',
                    '',
                    `Locator: getByText('${sentinel}')`,
                    'Expected: visible',
                    'Received: <element(s) not found>',
                    'Call log:',
                    '  - Element is not attached to the DOM',
                    'Timeout: 5000ms',
                ].join('\n'),
            ),
        ).toMatchObject({ received: 'detached' });
        const textual = classify(fixtures.valueMismatch);
        expect(textual).not.toHaveProperty('numbers');
        const hostile = classify(
            ['expect(received).toBe(expected)', 'Expected: 12abc', 'Received: 7'].join('\n'),
        );
        expect(hostile).not.toHaveProperty('numbers');
        const pageValue = classify(
            [
                'expect(locator).toHaveValue(expected) failed',
                '',
                `Locator: getByRole('textbox')`,
                'Expected: 12345',
                'Received: 67890',
                'Timeout: 5000ms',
            ].join('\n'),
        );
        expect(pageValue).not.toHaveProperty('numbers');
        expect(JSON.stringify([textual, hostile])).not.toContain(sentinel);
    });

    it('detects negation, chained locators, and buckets an odd timeout', () => {
        const failure = classifyE2EFailure([{ message: fixtures.locatorText }], context());
        expect(failure).toMatchObject({
            kind: 'assertion-timeout',
            locatorKind: 'chain',
            matcher: 'toHaveText',
            negated: true,
            received: 'wrong-value',
            timeoutMs: 10_000,
        });
    });

    it('classifies value mismatches, polls, actions, test timeouts, closed targets, and launch failures', () => {
        const kinds = Object.entries({
            valueMismatch: 'assertion-mismatch',
            pollTimeout: 'assertion-timeout',
            actionTimeout: 'action-timeout',
            testTimeout: 'test-timeout',
            targetClosed: 'target-closed',
            launch: 'launch-failed',
        } as const).map(([name, kind]) => [
            kind,
            classifyE2EFailure(
                [{ message: fixtures[name as keyof typeof fixtures] }],
                context({ status: name === 'testTimeout' ? 'timedOut' : 'failed' }),
            ),
        ]);
        for (const [kind, failure] of kinds) {
            expect(failure).toMatchObject({ kind });
            expect(JSON.stringify(failure)).not.toContain(sentinel);
        }
        expect(kinds[1][1]).toMatchObject({ receiver: 'poll', matcher: 'toBeTruthy' });
        expect(kinds[2][1]).toMatchObject({ action: 'click', timeoutMs: 15_000 });
        expect(kinds[3][1]).toMatchObject({ timeoutMs: 120_000 });
    });

    it('names a launch that threw inside the launch helper and reports the last stage and exit', () => {
        const helper = join(process.cwd(), 'e2e/support/helpers.ts');
        const failure = classifyE2EFailure(
            [
                {
                    message: `Error: ${sentinel}`,
                    stack: stack(
                        `launchCaxriApp (${helper}:200:5)`,
                        `Object.<anonymous> (${specFile}:12:3)`,
                    ),
                },
            ],
            context({ launch: { stage: 'electronLaunchMs' } }),
        );
        expect(failure).toMatchObject({
            kind: 'launch-failed',
            launchStage: 'electronLaunchMs',
            locationSource: 'spec',
        });
        const exited = classifyE2EFailure(
            [{ message: `Error: ${sentinel}` }],
            context({
                launch: { exit: { code: null, signal: 'SIGSEGV' }, stage: 'firstWindowMs' },
            }),
        );
        expect(exited).toMatchObject({
            exit: { code: null, signal: 'SIGSEGV' },
            kind: 'process-exited',
            locationSource: 'none',
        });
    });

    it('reports a helper-only stack as helper provenance, and no frame as none', () => {
        const pollingFile = join(process.cwd(), 'e2e/support/polling.ts');
        const helperOnly = classifyE2EFailure(
            [
                {
                    message: `Error: ${sentinel}`,
                    stack: stack(`wait (${pollingFile}:3:1)`),
                },
            ],
            context(),
        );
        expect(helperOnly).toMatchObject({ kind: 'helper-threw', locationSource: 'helper' });
        expect(classifyE2EFailure([], context())).toMatchObject({
            frames: [],
            kind: 'unknown',
            locationSource: 'none',
        });
    });

    it('drops frames outside e2e and keeps at most three', () => {
        const frames = Array.from(
            { length: 6 },
            (_, index) =>
                `f (${join(process.cwd(), `e2e/support/file${index}.ts`)}:${index + 1}:1)`,
        );
        const failure = classifyE2EFailure(
            [
                {
                    message: 'x',
                    stack: stack(
                        `a (${privateRoot}/src/other.ts:1:1)`,
                        `b (/Users/someone/code/e2e/../../etc/x.ts:1:1)`,
                        ...frames,
                    ),
                },
            ],
            context(),
        );
        expect(failure.frames).toEqual([
            'e2e/support/file0.ts:1',
            'e2e/support/file1.ts:2',
            'e2e/support/file2.ts:3',
        ]);
    });

    it('groups failures that differ only in dynamic text under one structural hash', () => {
        const at = (line: number) => stack(`Object.<anonymous> (${specFile}:${line}:7)`);
        const base = (text: string) =>
            classifyE2EFailure(
                [
                    {
                        message: fixtures.locatorMissing.split(sentinel).join(text),
                        stack: at(42),
                    },
                ],
                context(),
            );
        expect(base('one').structuralHash).toBe(base('two words').structuralHash);
        const otherLine = classifyE2EFailure(
            [{ message: fixtures.locatorMissing, stack: at(43) }],
            context(),
        );
        expect(otherLine.structuralHash).not.toBe(base('one').structuralHash);
    });

    it('passes the strict schema for every fixture and survives hostile input', () => {
        const hostile = [
            ...Object.values(fixtures).map((message) => ({ message })),
            { message: 'x'.repeat(200_000), stack: 'at '.repeat(100_000) },
            { message: '\u{0}'.repeat(10), stack: undefined },
        ];
        for (const error of hostile)
            expect(() =>
                publicE2EFailureClassSchema.parse(classifyE2EFailure([error], context())),
            ).not.toThrow();
        const forged = { ...classifyE2EFailure([], context()), message: sentinel };
        expect(publicE2EFailureClassSchema.safeParse(forged).success).toBe(false);
    });

    it('buckets timeouts and keeps the configured test timeout exact', () => {
        expect(bucketTimeoutMs(1, 120_000)).toBe(1000);
        expect(bucketTimeoutMs(4999, 120_000)).toBe(5000);
        expect(bucketTimeoutMs(15_000, 120_000)).toBe(15_000);
        expect(bucketTimeoutMs(15_001, 120_000)).toBe(30_000);
        expect(bucketTimeoutMs(61_000, 120_000)).toBe(120_000);
        expect(bucketTimeoutMs(900_000, 900_000)).toBe(900_000);
        expect(bucketTimeoutMs(NaN)).toBeUndefined();
    });

    it('classifies nothing for a passing attempt and hashes only the primary message', () => {
        expect(
            classifyTestResult({ errors: [], status: 'passed' }, { file: specFile }),
        ).toBeUndefined();
        expect(primaryErrorMessage({ error: undefined, errors: [{ message: 'a' }] })).toBe('a');
    });
});

describe('public failure class schema contract', () => {
    it('allows no free-text string field', () => {
        const pending: Array<[string, z.ZodType]> = Object.entries(
            publicE2EFailureClassSchema.shape,
        );
        let checked = 0;
        while (pending.length > 0) {
            const [path, field] = pending.pop()!;
            let current: z.ZodType = field;
            while (current instanceof z.ZodOptional || current instanceof z.ZodNullable)
                current = current.unwrap() as z.ZodType;
            if (current instanceof z.ZodArray) current = current.element as z.ZodType;
            if (current instanceof z.ZodObject) {
                for (const [key, child] of Object.entries(current.shape))
                    pending.push([`${path}.${key}`, child as z.ZodType]);
                continue;
            }
            checked += 1;
            if (current instanceof z.ZodString) {
                expect(current.def.checks?.length ?? 0, `${path} must be pattern-bounded`).toBe(1);
            } else {
                const isClosed = [z.ZodEnum, z.ZodBoolean, z.ZodNumber].some(
                    (kind) => current instanceof kind,
                );
                expect(isClosed, `${path} must be an enum, boolean, or bounded number`).toBe(true);
            }
        }
        expect(checked).toBeGreaterThan(10);
    });
});

describe('launch annotation', () => {
    it('round-trips closed values and drops everything else', () => {
        const info = { annotations: [] as Array<{ type: string; description?: string }> };
        annotateE2ELaunch(info, {
            exit: { code: 300, signal: 'SIGHUP' },
            note: sentinel,
            stage: 'electronLaunchMs',
        });
        annotateE2ELaunch(info, { stage: sentinel });
        expect(readPublicE2ELaunch(info.annotations)).toEqual({
            exit: { code: null, signal: null },
            stage: 'electronLaunchMs',
        });
        expect(JSON.stringify(info.annotations)).not.toContain(sentinel);
        expect(safeProcessExit(137, 'SIGKILL')).toEqual({ code: 137, signal: 'SIGKILL' });
        expect(
            readPublicE2ELaunch([{ type: 'caxri-public-launch', description: '{' }]),
        ).toBeUndefined();
    });
});

describe('public reporter failure class output', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('emits the class on a failed test-end event and nothing private', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        new PublicE2EReporter().onTestEnd(
            { location: { file: specFile, line: 1, column: 1 }, timeout: 120_000 } as TestCase,
            {
                annotations: [],
                duration: 5,
                errors: [
                    {
                        message: fixtures.locatorMissing,
                        stack: stack(`Object.<anonymous> (${specFile}:42:7)`),
                    },
                ],
                retry: 0,
                status: 'failed',
            } as unknown as TestResult,
        );
        const output = log.mock.calls.flat().join('\n');
        const event = JSON.parse(output.slice(output.indexOf('{'))) as {
            failureClass: unknown;
            failureLocation: unknown;
        };
        expect(publicE2EFailureClassSchema.parse(event.failureClass)).toMatchObject({
            kind: 'assertion-timeout',
        });
        expect(event.failureLocation).toEqual({ line: 42, column: 7 });
        expect(output).not.toContain(sentinel);
        expect(output).not.toContain('private');
    });

    it('omits the class for a passing test', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        new PublicE2EReporter().onTestEnd(
            { location: { file: specFile, line: 1, column: 1 } } as TestCase,
            {
                annotations: [],
                duration: 5,
                errors: [],
                retry: 0,
                status: 'passed',
            } as unknown as TestResult,
        );
        expect(log.mock.calls.flat().join('\n')).not.toContain('failureClass');
    });
});
