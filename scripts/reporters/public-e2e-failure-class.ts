import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import process from 'node:process';

import type { TestResult } from '@playwright/test/reporter';
import { z } from 'zod';

import type { PublicE2ELaunchState } from './public-e2e-launch';
import { publicE2EExitSignals, publicE2ELaunchStages } from './public-e2e-launch';

/**
 * The only module under `scripts/reporters/` allowed to read `.message`, `.snippet`, `.stack`, or `.cause` of a
 * Playwright error (enforced by `scripts/__tests__/ci-e2e-log-safety.test.ts`). It turns an error into closed enums and
 * bounded integers, so a public Actions log and the public receipts can say what kind of failure happened without ever
 * carrying an error message, a snippet, a path outside `e2e/`, or user text.
 */

const failureKinds = [
    'assertion-timeout',
    'assertion-mismatch',
    'action-timeout',
    'test-timeout',
    'launch-failed',
    'process-exited',
    'target-closed',
    'helper-threw',
    'unknown',
] as const;

const numericMatchers: ReadonlySet<string> = new Set([
    'toBe',
    'toBeCloseTo',
    'toBeGreaterThan',
    'toBeGreaterThanOrEqual',
    'toBeLessThan',
    'toBeLessThanOrEqual',
    'toEqual',
    'toHaveCount',
]);
const failureMatchers = [
    'toBe',
    'toBeAttached',
    'toBeChecked',
    'toBeCloseTo',
    'toBeDefined',
    'toBeDisabled',
    'toBeEditable',
    'toBeEmpty',
    'toBeEnabled',
    'toBeFalsy',
    'toBeFocused',
    'toBeGreaterThan',
    'toBeGreaterThanOrEqual',
    'toBeHidden',
    'toBeInViewport',
    'toBeLessThan',
    'toBeLessThanOrEqual',
    'toBeNull',
    'toBeTruthy',
    'toBeUndefined',
    'toBeVisible',
    'toContain',
    'toContainClass',
    'toContainEqual',
    'toContainText',
    'toEqual',
    'toHaveAccessibleDescription',
    'toHaveAccessibleName',
    'toHaveAttribute',
    'toHaveClass',
    'toHaveCount',
    'toHaveCSS',
    'toHaveId',
    'toHaveJSProperty',
    'toHaveLength',
    'toHaveProperty',
    'toHaveScreenshot',
    'toHaveText',
    'toHaveTitle',
    'toHaveURL',
    'toHaveValue',
    'toHaveValues',
    'toMatch',
    'toMatchAriaSnapshot',
    'toMatchObject',
    'toPass',
    'toStrictEqual',
    'toThrow',
    'other',
] as const;

const failureActions = [
    'check',
    'click',
    'dblclick',
    'dragTo',
    'evaluate',
    'fill',
    'focus',
    'goto',
    'hover',
    'press',
    'selectOption',
    'type',
    'uncheck',
    'waitFor',
    'waitForFunction',
    'waitForSelector',
    'waitForURL',
    'other',
] as const;

const failureLocatorKinds = [
    'role',
    'testid',
    'text',
    'label',
    'placeholder',
    'css',
    'xpath',
    'chain',
] as const;

/**
 * How a locator assertion's target resolved when the assertion gave up. `wrong-count` also covers a strict-mode
 * violation (several matches), and `detached` an element that left the DOM mid-assertion.
 */
const failureReceivedKinds = [
    'not-found',
    'hidden',
    'wrong-count',
    'wrong-value',
    'detached',
] as const;

/**
 * 15 s is the E2E `expect` timeout, so it gets its own bucket instead of reading as 30 s.
 */
const timeoutBucketsMs = [1000, 5000, 10_000, 15_000, 30_000, 60_000] as const;
const maxNumericEvidence = 1_000_000_000_000;
const numericEvidencePattern = /^-?\d{1,12}(?:\.\d{1,6})?$/u;
const frameSchema = z.string().regex(/^e2e\/[a-z\d._/-]{1,200}\.ts:\d{1,7}$/u);
const maxTimeoutMs = 3_600_000;

/**
 * Strict by design: every string field is a closed enum or an anchored pattern, never `z.string()`, so adding a
 * free-text field cannot pass review unnoticed (see the schema contract test).
 */
export const publicE2EFailureClassSchema = z.strictObject({
    action: z.enum(failureActions).optional(),
    exit: z
        .strictObject({
            code: z.number().int().min(0).max(255).nullable(),
            signal: z.enum(publicE2EExitSignals).nullable(),
        })
        .optional(),
    frames: z.array(frameSchema).max(3),
    kind: z.enum(failureKinds),
    launchStage: z.enum(publicE2ELaunchStages).optional(),
    locationSource: z.enum(['spec', 'helper', 'none']),
    locatorKind: z.enum(failureLocatorKinds).optional(),
    matcher: z.enum(failureMatchers).optional(),
    negated: z.boolean().optional(),
    receiver: z.enum(['locator', 'page', 'value', 'poll']).optional(),
    /**
     * The two numbers of a finite numeric mismatch (`toBe`, `toBeCloseTo`, `toHaveCount`, ...). Numbers carry no text,
     * so they may be public; a non-numeric side drops the whole field.
     */
    numbers: z
        .strictObject({
            expected: z.number().min(-maxNumericEvidence).max(maxNumericEvidence),
            received: z.number().min(-maxNumericEvidence).max(maxNumericEvidence),
        })
        .optional(),
    received: z.enum(failureReceivedKinds).optional(),
    structuralHash: z.string().regex(/^[a-f\d]{64}$/u),
    timeoutMs: z.number().int().min(0).max(maxTimeoutMs).optional(),
});
export type PublicE2EFailureClass = z.infer<typeof publicE2EFailureClassSchema>;

export interface FailureClassContext {
    /**
     * Absolute path of the spec file that owns the test.
     */
    file: string;
    launch?: PublicE2ELaunchState | undefined;
    status: TestResult['status'];
    /**
     * The configured per-test timeout, which is repository configuration rather than runner data.
     */
    testTimeoutMs?: number | undefined;
}

type ErrorLike = Pick<TestResult['errors'][number], 'message' | 'stack'> & {
    location?: { column: number; file: string; line: number };
};

const ansiPattern = new RegExp(String.raw`${String.fromCodePoint(27)}\[[\d;]*m`, 'gu');

function isCoordinate(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
}

function stripAnsi(text: string): string {
    return text.replaceAll(ansiPattern, '');
}

/**
 * The text a one-way hash may consume. It is only ever hashed (`stableErrorIdentity`) and never printed or stored.
 */
export function primaryErrorMessage(
    result: Pick<TestResult, 'error' | 'errors'>,
): string | undefined {
    return result.error?.message ?? result.errors[0]?.message;
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
export function specFailureLocation(
    file: string,
    errors: readonly ErrorLike[],
): { line: number; column: number } | undefined {
    for (const error of errors) {
        const location = error.location;
        if (location?.file === file && isCoordinate(location.line) && isCoordinate(location.column))
            return { line: location.line, column: location.column };
        const stackLocation = stackFailureLocation(file, error.stack);
        if (stackLocation) return stackLocation;
    }
    return undefined;
}

/**
 * Up to three `e2e/` frames as `path:line`. Frames outside the repository's `e2e/` tree (Playwright internals,
 * dependencies, anything under a home directory) are dropped, and the path is rebuilt relative to the working directory
 * so a runner prefix never survives.
 */
function e2eFrames(stack: string | undefined): string[] {
    const frames: string[] = [];
    const root = process.cwd();
    const lines = stack?.split('\n', 200) ?? [];
    for (const line of lines) {
        const text = line.trim();
        if (!text.startsWith('at ')) continue;
        const match =
            /(\/[^\s():]+\.ts|[A-Za-z]:[\\/][^\s():]+\.ts|e2e\/[^\s():]+\.ts):(\d{1,7}):\d{1,7}\)?$/u.exec(
                text,
            );
        if (!match) continue;
        const path = isAbsolute(match[1]) ? relative(root, match[1]) : match[1];
        const normalized = path.replaceAll('\\', '/');
        const candidate = `${normalized}:${match[2]}`;
        if (!frameSchema.safeParse(candidate).success) continue;
        if (!frames.includes(candidate)) frames.push(candidate);
        if (frames.length === 3) break;
    }
    return frames;
}

/**
 * Rounds a timeout up to the next coarse bucket. The configured test timeout is reported exactly because it is a
 * repository constant; anything beyond the largest bucket rounds up to whole minutes.
 */
export function bucketTimeoutMs(value: number, testTimeoutMs?: number): number | undefined {
    if (!Number.isFinite(value) || value < 0) return undefined;
    if (testTimeoutMs !== undefined && value === testTimeoutMs && testTimeoutMs <= maxTimeoutMs)
        return testTimeoutMs;
    const bucket = timeoutBucketsMs.find((candidate) => value <= candidate);
    if (bucket) return bucket;
    return Math.min(maxTimeoutMs, Math.ceil(value / 60_000) * 60_000);
}

function pick<const T extends readonly string[]>(options: T, value: string): T[number] | undefined {
    return options.find((candidate) => candidate === value);
}

function locatorKindOf(locator: string): (typeof failureLocatorKinds)[number] | undefined {
    const text = locator.trim();
    if (/\)\s*\.\s*(?:getBy\w+|locator|first|last|nth|filter|and|or)\s*\(|>>/u.test(text))
        return 'chain';
    const name = /^([A-Za-z]+)\(/u.exec(text)?.[1];
    switch (name) {
        case 'getByRole': {
            return 'role';
        }
        case 'getByTestId': {
            return 'testid';
        }
        case 'getByText':
        case 'getByAltText':
        case 'getByTitle': {
            return 'text';
        }
        case 'getByLabel': {
            return 'label';
        }
        case 'getByPlaceholder': {
            return 'placeholder';
        }
        case 'locator': {
            return /^locator\(\s*['"`]\s*(?:xpath=|\/\/)/u.test(text) ? 'xpath' : 'css';
        }
        default: {
            return undefined;
        }
    }
}

interface ParsedMessage {
    action?: (typeof failureActions)[number];
    locatorKind?: (typeof failureLocatorKinds)[number];
    matcher?: (typeof failureMatchers)[number];
    negated?: boolean;
    numbers?: { expected: number; received: number };
    receiver?: 'locator' | 'page' | 'value' | 'poll';
    received?: (typeof failureReceivedKinds)[number];
    timedOut?: boolean;
    timeoutMs?: number;
}

/**
 * The trimmed remainder of the first line that starts with one of the prefixes. Line splitting instead of a regex keeps
 * a hostile 20 kB message from backtracking.
 */
function lineValue(message: string, prefixes: readonly string[]): string | undefined {
    for (const line of message.split('\n', 200)) {
        const prefix = prefixes.find((candidate) => line.startsWith(candidate));
        if (prefix) return line.slice(prefix.length).trim();
    }
    return undefined;
}

/**
 * A finite number from an `Expected:` or `Received:` line, or nothing for any other text. The anchored pattern is what
 * keeps a string, a path, or a regular expression from ever passing as a number.
 */
function numericLine(message: string, prefix: 'Expected:' | 'Received:'): number | undefined {
    const text = lineValue(message, [prefix]);
    if (text === undefined || !numericEvidencePattern.test(text)) return undefined;
    const value = Number(text);
    return Number.isFinite(value) && Math.abs(value) <= maxNumericEvidence ? value : undefined;
}

function parseMessage(rawMessage: string): ParsedMessage {
    const message = stripAnsi(rawMessage.slice(0, 20_000));
    const parsed: ParsedMessage = {};
    const header =
        /expect(?:\.(?:soft|poll))?\((\w+)\)(?:\.(resolves|rejects|poll))?(\.not)?\.(\w+)\(/u.exec(
            message,
        );
    if (header) {
        const [, receiver, promise, not, matcher] = header;
        parsed.matcher = pick(failureMatchers, matcher) ?? 'other';
        parsed.negated = Boolean(not);
        parsed.receiver =
            receiver === 'locator' ? 'locator' : receiver === 'page' ? 'page' : 'value';
        if (promise === 'poll') parsed.receiver = 'poll';
        const locator = lineValue(message, ['Locator:']);
        if (locator) parsed.locatorKind = locatorKindOf(locator);
        const receivedLine = lineValue(message, [
            'Received:',
            'Received string:',
            'Received pattern:',
            'Received value:',
        ]);
        if (receivedLine !== undefined && parsed.receiver !== 'value') {
            parsed.received = receivedLine.includes('element(s) not found')
                ? 'not-found'
                : /^(?:hidden|<hidden>)$/u.test(receivedLine.trim())
                  ? 'hidden'
                  : parsed.matcher === 'toHaveCount' && numericEvidencePattern.test(receivedLine)
                    ? 'wrong-count'
                    : 'wrong-value';
        }
        const expected = numericLine(message, 'Expected:');
        const received = numericLine(message, 'Received:');
        // Only matchers that compare values the spec computed: a text or value matcher would publish page content.
        if (
            expected !== undefined &&
            received !== undefined &&
            numericMatchers.has(parsed.matcher ?? 'other')
        )
            parsed.numbers = { expected, received };
    }
    // Playwright prints `Error: element(s) not found` instead of a `Received:` line when a visibility or attachment
    // matcher never found its element.
    if (!parsed.received && /^Error: element\(s\) not found$/mu.test(message))
        parsed.received = 'not-found';
    if (/strict mode violation/u.test(message)) parsed.received = 'wrong-count';
    else if (/element is not attached to the DOM|Element is not attached/iu.test(message))
        parsed.received = 'detached';
    else if (!parsed.received && /unexpected value "hidden"/u.test(message))
        parsed.received = 'hidden';
    if (/while waiting on the predicate/u.test(message)) parsed.receiver = 'poll';
    const assertionTimeout = /^Timeout: +(\d{1,9})ms$/mu.exec(message)?.[1];
    const pollTimeout = /Timeout (\d{1,9})ms exceeded while waiting on the predicate/u.exec(
        message,
    )?.[1];
    const actionMatch =
        /^(?:Error: )?(?:page|locator|frame|elementHandle|browserContext)\.(\w+): Timeout (\d{1,9})ms exceeded/mu.exec(
            message,
        );
    if (assertionTimeout || pollTimeout) {
        parsed.timedOut = true;
        parsed.timeoutMs = Number(assertionTimeout ?? pollTimeout);
    } else if (actionMatch) {
        parsed.action = pick(failureActions, actionMatch[1]) ?? 'other';
        parsed.timeoutMs = Number(actionMatch[2]);
        parsed.timedOut = true;
        const receiver = /^(?:Error: )?(page|locator|frame|elementHandle|browserContext)\./mu.exec(
            message,
        )?.[1];
        parsed.receiver = receiver === 'locator' ? 'locator' : 'page';
    }
    return parsed;
}

function structuralHash(failure: Omit<PublicE2EFailureClass, 'structuralHash'>): string {
    return createHash('sha256')
        .update(
            JSON.stringify([
                failure.kind,
                failure.matcher ?? null,
                failure.receiver ?? null,
                failure.locatorKind ?? null,
                failure.frames[0] ?? null,
            ]),
        )
        .digest('hex');
}

/**
 * Classifies a failed test's first error into the public closed shape. Pure and total: it never throws and every input
 * yields a valid {@link PublicE2EFailureClass}, with `unknown` as the fallback.
 */
export function classifyE2EFailure(
    errors: readonly ErrorLike[],
    context: FailureClassContext,
): PublicE2EFailureClass {
    const first = errors.at(0);
    const message = first?.message ?? '';
    const stack = first?.stack;
    const parsed = parseMessage(message);
    const frames = e2eFrames(stack);
    const specLocation = specFailureLocation(context.file, errors);
    const locationSource: PublicE2EFailureClass['locationSource'] = specLocation
        ? 'spec'
        : frames.length > 0
          ? 'helper'
          : 'none';
    const exit = context.launch?.exit;
    const isInLaunchHelper = /\bat (?:async )?(?:Object\.)?launchCaxri(?:App)?\b/u.test(
        stack?.slice(0, 20_000) ?? '',
    );
    const lower = stripAnsi(message.slice(0, 20_000));

    let kind: PublicE2EFailureClass['kind'] = 'unknown';
    if (context.status === 'timedOut' || /Test timeout of \d+ms exceeded/u.test(lower)) {
        kind = 'test-timeout';
    } else if (parsed.matcher && parsed.timedOut) {
        kind = 'assertion-timeout';
    } else if (parsed.matcher) {
        kind = 'assertion-mismatch';
    } else if (parsed.action) {
        kind = 'action-timeout';
    } else if (
        /Target (?:page, context or browser )?(?:has been )?closed|browser has been closed|Execution context was destroyed/iu.test(
            lower,
        )
    ) {
        kind = 'target-closed';
    } else if (exit && (exit.code !== null || exit.signal !== null)) {
        kind = 'process-exited';
    } else if (
        isInLaunchHelper ||
        /\b(?:electron|browserType)\.launch\b|Process failed to launch|Build output is stale/u.test(
            lower,
        )
    ) {
        kind = 'launch-failed';
    } else if (locationSource === 'helper' && frames[0]?.startsWith('e2e/support/')) {
        kind = 'helper-threw';
    }

    const timeoutSource =
        kind === 'test-timeout'
            ? (/Test timeout of (\d{1,9})ms exceeded/u.exec(lower)?.[1] ?? context.testTimeoutMs)
            : parsed.timeoutMs;
    const timeoutMs =
        timeoutSource === undefined
            ? undefined
            : bucketTimeoutMs(Number(timeoutSource), context.testTimeoutMs);
    const draft = {
        ...(parsed.action && { action: parsed.action }),
        ...(exit && { exit }),
        frames,
        kind,
        ...(context.launch?.stage && { launchStage: context.launch.stage }),
        locationSource,
        ...(parsed.locatorKind && { locatorKind: parsed.locatorKind }),
        ...(parsed.matcher && { matcher: parsed.matcher }),
        ...(parsed.matcher && { negated: parsed.negated ?? false }),
        ...(parsed.numbers && { numbers: parsed.numbers }),
        ...(parsed.receiver && { receiver: parsed.receiver }),
        ...(parsed.received && { received: parsed.received }),
        ...(timeoutMs !== undefined && { timeoutMs }),
    } satisfies Omit<PublicE2EFailureClass, 'structuralHash'>;
    return publicE2EFailureClassSchema.parse({ ...draft, structuralHash: structuralHash(draft) });
}

/**
 * Failure class for a finished attempt, or `undefined` when it did not fail. Never throws: a classifier bug degrades to
 * `unknown` instead of taking down the public log.
 */
export function classifyTestResult(
    result: Pick<TestResult, 'errors' | 'status'>,
    context: Omit<FailureClassContext, 'status'>,
): PublicE2EFailureClass | undefined {
    if (result.status === 'passed' || result.status === 'skipped') return undefined;
    try {
        return classifyE2EFailure(result.errors, { ...context, status: result.status });
    } catch {
        const fallback: Omit<PublicE2EFailureClass, 'structuralHash'> = {
            frames: [],
            kind: 'unknown',
            locationSource: 'none',
        };
        return { ...fallback, structuralHash: structuralHash(fallback) };
    }
}
