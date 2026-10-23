import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
    refineRendererPerformanceScenario,
    rendererPerformanceScenarioDiagnosticSchema,
} from '@caxri/protocol';
import { z } from 'zod';

import { assertE2EPoolReceipt } from './reporters/e2e-receipt-reporter';

const poolNames = ['parallel-safe', 'desktop-exclusive', 'control', 'release-packaged'] as const;
const verdictSchema = z.enum(['fail', 'pass', 'skipped', 'timeout', 'unknown']);
const nonNegativeIntegerSchema = z.number().int().nonnegative().max(1_000_000);
const boundedStringSchema = z.string().max(4_096);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const safeRelativePathSchema = z
    .string()
    .min(1)
    .max(4_096)
    .refine(
        (path) =>
            !isAbsolute(path) &&
            !/^[a-z]:[\\/]/iu.test(path) &&
            !path.startsWith('\\\\') &&
            !path.includes('\\') &&
            !path.split('/').includes('..'),
        'path must stay repository-relative',
    );
const publicSpecPathSchema = z
    .string()
    .regex(/^e2e\/[a-z\d][a-z\d.-]*\.e2e\.ts$/u, 'spec path must name a root E2E spec');

const internalAbortedInvocationSchema = z.strictObject({
    exitCode: z.number().int(),
    specs: z.array(safeRelativePathSchema).max(10_000),
});

const internalFailureGroupSchema = z.strictObject({
    count: nonNegativeIntegerSchema,
    identity: sha256Schema,
    testIds: z.array(boundedStringSchema).max(10_000),
});

const internalTestReceiptSchema = z.strictObject({
    artifacts: z.array(safeRelativePathSchema).max(100),
    durationMs: nonNegativeIntegerSchema,
    errorIdentity: sha256Schema.nullable(),
    /**
     * The failed first attempt of a test the Release pools may retry once (`e2e/startup.performance.e2e.ts`). The
     * public projection drops it: the Actions log already carries the `Flaky E2E pass` warning for that case.
     */
    firstFailure: z
        .strictObject({
            errorIdentity: sha256Schema.nullable(),
            verdict: z.enum(['fail', 'timeout']),
        })
        .optional(),
    id: boundedStringSchema,
    location: safeRelativePathSchema,
    title: boundedStringSchema,
    verdict: verdictSchema,
});

const internalSpecReceiptSchema = z.strictObject({
    durationMs: nonNegativeIntegerSchema,
    path: safeRelativePathSchema,
    testIds: z.array(boundedStringSchema).max(10_000),
    verdict: z.enum(['fail', 'pass', 'timeout', 'unknown']),
});

const internalPoolReceiptSchema = z.strictObject({
    abortedInvocations: z.array(internalAbortedInvocationSchema).max(10_000).optional(),
    abortReason: z.enum(['SIGINT', 'SIGTERM']).optional(),
    failed: nonNegativeIntegerSchema,
    failureGroups: z.array(internalFailureGroupSchema).max(10_000),
    finished: nonNegativeIntegerSchema,
    finishedAt: boundedStringSchema,
    hash: sha256Schema,
    missingSpecs: z.array(safeRelativePathSchema).max(10_000).optional(),
    passed: nonNegativeIntegerSchema,
    planned: nonNegativeIntegerSchema,
    pool: z.enum(poolNames),
    skipped: nonNegativeIntegerSchema,
    specs: z.array(internalSpecReceiptSchema).max(10_000),
    started: nonNegativeIntegerSchema,
    startedAt: boundedStringSchema,
    status: z.enum(['failed', 'passed']),
    tests: z.array(internalTestReceiptSchema).max(10_000),
    timedOut: nonNegativeIntegerSchema,
    unknown: nonNegativeIntegerSchema,
});

const publicAbortedInvocationSchema = z.strictObject({
    exitCode: z.number().int(),
    specs: z.array(publicSpecPathSchema).max(10_000),
});

const publicHashedFailureSchema = z.strictObject({
    classification: z.literal('stable-error-hash'),
    errorIdentity: sha256Schema,
    spec: publicSpecPathSchema,
    verdict: z.enum(['fail', 'timeout']),
});

const publicMissingErrorFailureSchema = z.strictObject({
    classification: z.literal('missing-error'),
    spec: publicSpecPathSchema,
    verdict: z.enum(['fail', 'timeout']),
});

const publicFailureSchema = z.discriminatedUnion('classification', [
    publicHashedFailureSchema,
    publicMissingErrorFailureSchema,
]);

const publicSpecSchema = z.strictObject({
    durationMs: nonNegativeIntegerSchema,
    path: publicSpecPathSchema,
    testCount: nonNegativeIntegerSchema,
    verdict: z.enum(['fail', 'pass', 'timeout', 'unknown']),
});

export const publicE2EPoolReceiptSchema = z.strictObject({
    abortReason: z.enum(['SIGINT', 'SIGTERM']).optional(),
    abortedInvocations: z.array(publicAbortedInvocationSchema),
    counts: z.strictObject({
        failed: nonNegativeIntegerSchema,
        finished: nonNegativeIntegerSchema,
        passed: nonNegativeIntegerSchema,
        planned: nonNegativeIntegerSchema,
        skipped: nonNegativeIntegerSchema,
        started: nonNegativeIntegerSchema,
        timedOut: nonNegativeIntegerSchema,
        unknown: nonNegativeIntegerSchema,
    }),
    failures: z.array(publicFailureSchema),
    hash: sha256Schema,
    kind: z.literal('public-e2e-pool-receipt'),
    missingSpecs: z.array(publicSpecPathSchema).max(10_000),
    pool: z.enum(poolNames),
    specs: z.array(publicSpecSchema),
    status: z.enum(['failed', 'passed']),
    version: z.literal(1),
});

const publicRendererPerformanceReceiptSchema =
    rendererPerformanceScenarioDiagnosticSchema.superRefine(refineRendererPerformanceScenario);

function specPath(location: string): string {
    return location.replace(/(?::\d+)+$/u, '');
}

export function toPublicE2EPoolReceipt(value: unknown): z.infer<typeof publicE2EPoolReceiptSchema> {
    const receipt = internalPoolReceiptSchema.parse(value);
    assertE2EPoolReceipt(receipt);
    return publicE2EPoolReceiptSchema.parse({
        abortReason: receipt.abortReason,
        abortedInvocations: (receipt.abortedInvocations ?? []).map(({ exitCode, specs }) => ({
            exitCode,
            specs: specs.map(specPath),
        })),
        counts: {
            failed: receipt.failed,
            finished: receipt.finished,
            passed: receipt.passed,
            planned: receipt.planned,
            skipped: receipt.skipped,
            started: receipt.started,
            timedOut: receipt.timedOut,
            unknown: receipt.unknown,
        },
        failures: receipt.tests.flatMap(({ errorIdentity, location, verdict }) => {
            if (verdict !== 'fail' && verdict !== 'timeout') return [];
            const spec = specPath(location);
            return errorIdentity
                ? [{ classification: 'stable-error-hash', errorIdentity, spec, verdict }]
                : [{ classification: 'missing-error', spec, verdict }];
        }),
        hash: receipt.hash,
        kind: 'public-e2e-pool-receipt',
        missingSpecs: (receipt.missingSpecs ?? []).map(specPath),
        pool: receipt.pool,
        specs: receipt.specs.map(({ durationMs, path, testIds, verdict }) => ({
            durationMs,
            path,
            testCount: testIds.length,
            verdict,
        })),
        status: receipt.status,
        version: 1,
    });
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

async function readJsonIfPresent(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
    }
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function stagePoolReceipt(options: {
    pool: (typeof poolNames)[number];
    sourceDirectory: string;
    temporaryDirectory: string;
}): Promise<string | undefined> {
    const fileName = `${options.pool}.json`;
    const inputPath = join(options.sourceDirectory, fileName);
    const input = await readJsonIfPresent(inputPath);
    if (input === undefined) return undefined;
    const outputPath = join(options.temporaryDirectory, fileName);
    const receipt = toPublicE2EPoolReceipt(input);
    if (receipt.pool !== options.pool) {
        throw new Error(`E2E receipt pool does not match ${fileName}`);
    }
    await writeJson(outputPath, receipt);
    return fileName;
}

export async function preparePublicE2EReceipts(options: {
    outputDirectory: string;
    sourceDirectory: string;
}): Promise<string[]> {
    const sourceDirectory = resolve(options.sourceDirectory);
    const outputDirectory = resolve(options.outputDirectory);
    if (
        basename(sourceDirectory) !== 'receipts' ||
        basename(outputDirectory) !== 'public-receipts' ||
        dirname(sourceDirectory) !== dirname(outputDirectory)
    ) {
        throw new Error(
            'Public E2E receipts must be staged beside the internal receipts directory',
        );
    }

    const parent = dirname(outputDirectory);
    await mkdir(parent, { recursive: true });
    await rm(outputDirectory, { force: true, recursive: true });
    const temporaryDirectory = await mkdtemp(join(parent, '.public-e2e-receipts-'));
    try {
        const poolFiles = await Promise.all(
            poolNames.map((pool) =>
                stagePoolReceipt({ pool, sourceDirectory, temporaryDirectory }),
            ),
        );
        const written = poolFiles.filter((fileName): fileName is string => fileName !== undefined);

        const rendererFileName = 'renderer-performance.json';
        const rendererInput = await readJsonIfPresent(join(sourceDirectory, rendererFileName));
        if (rendererInput !== undefined) {
            await writeJson(
                join(temporaryDirectory, rendererFileName),
                publicRendererPerformanceReceiptSchema.parse(rendererInput),
            );
            written.push(rendererFileName);
        }

        await rename(temporaryDirectory, outputDirectory);
        return written.toSorted((left, right) => left.localeCompare(right));
    } catch (error) {
        await Promise.all([
            rm(temporaryDirectory, { force: true, recursive: true }),
            rm(outputDirectory, { force: true, recursive: true }),
        ]);
        throw error;
    }
}

if (import.meta.main) {
    const written = await preparePublicE2EReceipts({
        outputDirectory: 'test-results/public-receipts',
        sourceDirectory: 'test-results/receipts',
    });
    console.log(`Prepared ${written.length} public E2E receipt(s): ${written.join(', ')}`);
}
