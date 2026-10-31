import type { TestCaseIterationResult } from '@perf-profiler/types';
import { describe, expect, it } from 'vitest';

import {
    isDebuggablePackageDump,
    parseAndroidBenchmarkArguments,
    parseAndroidFlowArguments,
    summarizeAndroidBenchmark,
    summarizeAndroidBenchmarkIteration,
} from '../android-flow-receipts';

const iteration = (
    fps: number[],
    cpu: number,
    ram: number,
    time: number,
): TestCaseIterationResult => ({
    measures: fps.map((value, index) => ({
        cpu: { perCore: {}, perName: { mqt_v_js: cpu / 2, RenderThread: cpu / 2 } },
        fps: value,
        ram: ram + index,
        time: index * 500,
    })),
    status: 'SUCCESS',
    time,
});

describe('Android flow arguments', () => {
    it('requires a disposable emulator because flows clear app data', () => {
        expect(() => parseAndroidFlowArguments(['--serial', '192.168.1.5:5555'])).toThrow(
            'disposable',
        );
        expect(() => parseAndroidFlowArguments([])).toThrow('disposable');
    });

    it('collects positional flow names and rejects path traversal', () => {
        expect(
            parseAndroidFlowArguments(['--', '--serial', 'emulator-5742', 'launch-to-pairing']),
        ).toEqual({ flows: ['launch-to-pairing'], serial: 'emulator-5742' });
        expect(() =>
            parseAndroidFlowArguments(['--serial', 'emulator-5742', '../secrets']),
        ).toThrow('Invalid flow name');
    });

    it('defaults the benchmark to five launch iterations and bounds overrides', () => {
        expect(parseAndroidBenchmarkArguments(['--serial', 'emulator-5554'])).toEqual({
            flow: 'launch-to-pairing',
            iterations: 5,
            serial: 'emulator-5554',
        });
        expect(
            parseAndroidBenchmarkArguments([
                '--serial',
                'emulator-5554',
                '--flow',
                'pairing-paste-round-trip',
                '--iterations',
                '3',
                '--duration-ms',
                '8000',
            ]),
        ).toEqual({
            durationMs: 8_000,
            flow: 'pairing-paste-round-trip',
            iterations: 3,
            serial: 'emulator-5554',
        });
        expect(() =>
            parseAndroidBenchmarkArguments(['--serial', 'emulator-5554', '--iterations', '50']),
        ).toThrow('--iterations');
    });
});

describe('Android benchmark summary', () => {
    it('skips pre-first-frame samples, sums thread CPU, and keeps the FPS floor and RAM peak', () => {
        expect(
            summarizeAndroidBenchmarkIteration(iteration([0, 0, 60, 30, 57], 80, 200, 1_234.4)),
        ).toEqual({
            averageFps: 49,
            averageTotalCpuPercent: 80,
            minimumFps: 30,
            peakRamMb: 204,
            runTimeMs: 1_234,
        });
    });

    it('rejects an iteration without samples instead of reporting zeros', () => {
        expect(() =>
            summarizeAndroidBenchmarkIteration({ measures: [], status: 'SUCCESS', time: 10 }),
        ).toThrow('no samples');
    });

    it('uses medians across iterations and the worst floor and peak', () => {
        const receipts = [
            summarizeAndroidBenchmarkIteration(iteration([60], 40, 180, 1_000)),
            summarizeAndroidBenchmarkIteration(iteration([20], 300, 400, 9_000)),
            summarizeAndroidBenchmarkIteration(iteration([58], 50, 190, 1_200)),
        ];
        expect(summarizeAndroidBenchmark(receipts)).toEqual({
            medianAverageFps: 58,
            medianRunTimeMs: 1_200,
            medianTotalCpuPercent: 50,
            peakRamMb: 400,
            worstMinimumFps: 20,
        });
    });
});

describe('Android package dump', () => {
    it('reads DEBUGGABLE only from the application flags line', () => {
        expect(
            isDebuggablePackageDump(
                '    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]\n    privateFlags=[ ]',
            ),
        ).toBe(true);
        expect(
            isDebuggablePackageDump(
                '    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]\n    pkgFlags=[ DEBUGGABLE ]',
            ),
        ).toBe(false);
    });
});
