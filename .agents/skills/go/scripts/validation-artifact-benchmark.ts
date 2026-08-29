import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { inspectValidationLog, reconcileValidationArtifacts } from './validation-artifact';
import { completeValidation, startValidation } from './validation-gate';

interface BenchmarkSample {
    inspectedArtifacts: number;
    medianMs: number;
}

function integerOption(name: string, fallback: number): number {
    const index = process.argv.indexOf(name);
    const raw = index === -1 ? String(fallback) : process.argv[index + 1];
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

async function validationFixture(runDirectory: string, count: number) {
    const state = {
        mutationLease: null,
        runBudget: {
            policy: { validationRepairLimit: 3 },
            repairStops: [] as Array<{ at: string; lineageId: string; reason: string }>,
        },
        validations: [],
    };
    for (let index = 0; index < count; index += 1) {
        const record = startValidation(state, {
            artifactVersion: 1,
            command: `benchmark validation ${index}`,
            headSha: 'benchmark-head',
            kind: 'fixture',
            lineageId: `benchmark-${index}`,
            sourceFingerprint: 'benchmark-source',
        });
        // eslint-disable-next-line no-await-in-loop -- ordered receipts model the append-only ledger
        await writeFile(join(runDirectory, record.logPath), `validation ${index}\n`, 'utf8');
        // eslint-disable-next-line no-await-in-loop -- every receipt binds its own direct-file metadata
        const receipt = await inspectValidationLog(runDirectory, record.logPath);
        completeValidation(state, {
            clean: true,
            exitCode: 0,
            headSha: record.headSha,
            id: record.id,
            logByteLength: receipt.byteLength,
            logMetadata: receipt.metadata,
            logSha256: receipt.sha256,
            sourceFingerprint: record.sourceFingerprint,
            termination: 'exit',
        });
    }
    return state;
}

async function measure(
    state: Awaited<ReturnType<typeof validationFixture>>,
    runDirectory: string,
    verification: 'full' | 'metadata',
    iterations: number,
): Promise<BenchmarkSample> {
    const durations: number[] = [];
    let inspectedArtifacts = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const startedAt = performance.now();
        // eslint-disable-next-line no-await-in-loop -- sequential samples avoid overlapping filesystem noise
        inspectedArtifacts = await reconcileValidationArtifacts(state, runDirectory, verification);
        durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    return {
        inspectedArtifacts,
        medianMs: Number(durations[Math.floor(durations.length / 2)].toFixed(3)),
    };
}

async function main(): Promise<void> {
    const largeHistorySize = integerOption('--size', 256);
    const ordinaryIterations = integerOption('--iterations', 20);
    const fullIterations = integerOption('--full-iterations', 2);
    const runDirectory = await mkdtemp(join(tmpdir(), 'caxri-validation-benchmark-'));
    try {
        await mkdir(join(runDirectory, 'validation'));
        const large = await validationFixture(runDirectory, largeHistorySize);
        const small = { validations: large.validations.slice(0, 1) };
        const ordinarySmall = await measure(
            small as typeof large,
            runDirectory,
            'metadata',
            ordinaryIterations,
        );
        const ordinaryLarge = await measure(large, runDirectory, 'metadata', ordinaryIterations);
        const explicitFull = await measure(large, runDirectory, 'full', fullIterations);
        if (
            ordinarySmall.inspectedArtifacts !== 1 ||
            ordinaryLarge.inspectedArtifacts !== 1 ||
            explicitFull.inspectedArtifacts !== largeHistorySize
        ) {
            throw new Error('Validation artifact inspection count violated the benchmark contract');
        }
        console.log(
            JSON.stringify(
                {
                    explicitFull,
                    historySizes: { large: largeHistorySize, small: 1 },
                    ordinary: { large: ordinaryLarge, small: ordinarySmall },
                    schemaVersion: 1,
                },
                null,
                2,
            ),
        );
    } finally {
        await rm(runDirectory, { force: true, recursive: true });
    }
}

await main();
