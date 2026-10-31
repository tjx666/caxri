#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { androidAdbPath, CAXRI_ANDROID_PACKAGE } from './android-device-bridge';
import type { AndroidBenchmarkIterationReceipt } from './android-flow-receipts';
import {
    parseAndroidBenchmarkArguments,
    summarizeAndroidBenchmark,
    summarizeAndroidBenchmarkIteration,
} from './android-flow-receipts';
import {
    clearCaxriData,
    isInstalledCaxriDebuggable,
    requireInstalledCaxri,
    runAndroidFlows,
} from './android-flow-runner';

const receiptsDirectory = join(import.meta.dirname, '..', '..', '..', 'test-results', 'receipts');

const main = async (): Promise<void> => {
    const input = parseAndroidBenchmarkArguments(process.argv.slice(2));
    requireInstalledCaxri(input.serial);
    // Flashlight runs bare `adb` commands without `-s` and resolves `adb` from PATH. ADB honors ANDROID_SERIAL, which
    // pins every one of them to the selected emulator while sibling sessions keep their own emulators attached.
    process.env.ANDROID_SERIAL = input.serial;
    process.env.PATH = `${dirname(androidAdbPath())}:${process.env.PATH ?? ''}`;
    const { measurePerformance } = await import('@perf-profiler/e2e');

    const { measures } = await measurePerformance(
        CAXRI_ANDROID_PACKAGE,
        {
            ...(input.durationMs && { duration: input.durationMs }),
            // Clear before the profiler attaches: a clear during measurement kills the measured process and aborts
            // Flashlight's on-device poller.
            beforeTest: () => {
                clearCaxriData(input.serial);
            },
            run: async () => {
                if ((await runAndroidFlows(input.serial, [input.flow], 'errors-only')) !== 0)
                    throw new Error(`Flow ${input.flow} failed`);
            },
        },
        { iterationCount: input.iterations },
    );

    const iterations: AndroidBenchmarkIterationReceipt[] = measures
        .filter((iteration) => iteration.status === 'SUCCESS')
        .map((iteration) => summarizeAndroidBenchmarkIteration(iteration));
    const failedIterations = measures.length - iterations.length;
    const receipt = {
        advisory:
            'Emulator timings compare builds on the same host; they are not physical-device budgets.',
        debuggable: isInstalledCaxriDebuggable(input.serial),
        failedIterations,
        flow: input.flow,
        iterations,
        requestedIterations: input.iterations,
        package: CAXRI_ANDROID_PACKAGE,
        schemaVersion: 1,
        serial: input.serial,
        summary: summarizeAndroidBenchmark(iterations),
    };
    await mkdir(receiptsDirectory, { recursive: true });
    const receiptPath = join(receiptsDirectory, `mobile-android-benchmark-${input.flow}.json`);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt.summary, null, 2));
    console.log(`receipt ${receiptPath}`);
    // Retried failures shrink the sample a median rests on, so a run with any failure is not a clean baseline.
    if (failedIterations > 0 || iterations.length < input.iterations) {
        console.error(
            `${failedIterations} iteration(s) failed; the summary is not a clean baseline`,
        );
        process.exitCode = 1;
    }
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
