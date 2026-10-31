import type { TestCaseIterationResult } from '@perf-profiler/types';

/**
 * Flows clear app data, so they accept only a disposable emulator and never a user-owned phone.
 */
const EMULATOR_SERIAL = /^emulator-\d+$/u;
const FLOW_NAME = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const DEFAULT_BENCHMARK_FLOW = 'launch-to-pairing';
const DEFAULT_ITERATIONS = 5;
const MAX_ITERATIONS = 20;

export interface AndroidFlowArguments {
    flows: string[];
    serial: string;
}

export interface AndroidBenchmarkArguments {
    durationMs?: number;
    flow: string;
    iterations: number;
    serial: string;
}

const argumentAfter = (values: string[], name: string): string | undefined => {
    const index = values.indexOf(name);
    return index === -1 ? undefined : values[index + 1];
};

const requireEmulatorSerial = (values: string[]): string => {
    const serial = argumentAfter(values, '--serial');
    if (!serial || !EMULATOR_SERIAL.test(serial))
        throw new Error('An explicit disposable --serial emulator-<port> is required');
    return serial;
};

const requireFlowName = (name: string): string => {
    if (!FLOW_NAME.test(name)) throw new Error(`Invalid flow name: ${name}`);
    return name;
};

const boundedInteger = (value: string, name: string, min: number, max: number): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
        throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return parsed;
};

/**
 * Positional arguments name flows under `apps/mobile/flows/` without the `.yaml` suffix; none runs every flow.
 */
export const parseAndroidFlowArguments = (values: string[]): AndroidFlowArguments => {
    const normalized = values.filter((value) => value !== '--');
    const serial = requireEmulatorSerial(normalized);
    const flows = normalized
        .filter((value, index) => !value.startsWith('--') && normalized[index - 1] !== '--serial')
        .map(requireFlowName);
    return { flows, serial };
};

export const parseAndroidBenchmarkArguments = (values: string[]): AndroidBenchmarkArguments => {
    const normalized = values.filter((value) => value !== '--');
    const serial = requireEmulatorSerial(normalized);
    const flow = requireFlowName(argumentAfter(normalized, '--flow') ?? DEFAULT_BENCHMARK_FLOW);
    const iterationsValue = argumentAfter(normalized, '--iterations');
    const durationValue = argumentAfter(normalized, '--duration-ms');
    return {
        ...(durationValue && {
            durationMs: boundedInteger(durationValue, '--duration-ms', 1_000, 120_000),
        }),
        flow,
        iterations: iterationsValue
            ? boundedInteger(iterationsValue, '--iterations', 1, MAX_ITERATIONS)
            : DEFAULT_ITERATIONS,
        serial,
    };
};

/**
 * Matches the application `flags=[ ... ]` line of `dumpsys package`, not the separate `pkgFlags` line.
 */
export const isDebuggablePackageDump = (source: string): boolean =>
    /^\s*flags=\[[^\]]*\bDEBUGGABLE\b/mu.test(source);

export interface AndroidBenchmarkIterationReceipt {
    averageFps?: number;
    /**
     * Sum of every sampled thread's CPU percentage, so a value above 100 means more than one busy core.
     */
    averageTotalCpuPercent: number;
    minimumFps?: number;
    peakRamMb?: number;
    runTimeMs: number;
}

export interface AndroidBenchmarkSummary {
    medianAverageFps?: number;
    medianRunTimeMs: number;
    medianTotalCpuPercent: number;
    peakRamMb?: number;
    worstMinimumFps?: number;
}

const round = (value: number, digits = 1): number => {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
};

const average = (values: number[]): number =>
    values.reduce((total, value) => total + value, 0) / values.length;

const median = (values: number[]): number => {
    const sorted = values.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * Projects one Flashlight iteration to content-free numbers. FPS comes from Flashlight's on-device poller, not
 * `gfxinfo`: agent-device stops the app when a flow ends, so its frame counters are gone before they can be read.
 */
export const summarizeAndroidBenchmarkIteration = (
    iteration: TestCaseIterationResult,
): AndroidBenchmarkIterationReceipt => {
    if (iteration.measures.length === 0) throw new Error('Flashlight recorded no samples');
    const sampledFps = iteration.measures.flatMap((measure) =>
        typeof measure.fps === 'number' ? [measure.fps] : [],
    );
    // Samples before the first drawn frame read 0 FPS while the process starts; counting them would pin every launch
    // flow's floor at 0 and drag its average toward startup time instead of rendering smoothness.
    const firstFrame = sampledFps.findIndex((value) => value > 0);
    const fps = firstFrame === -1 ? [] : sampledFps.slice(firstFrame);
    const ram = iteration.measures.flatMap((measure) =>
        typeof measure.ram === 'number' ? [measure.ram] : [],
    );
    const totalCpu = iteration.measures.map((measure) =>
        Object.values(measure.cpu.perName).reduce((total, value) => total + value, 0),
    );
    return {
        ...(fps.length > 0 && {
            averageFps: round(average(fps)),
            minimumFps: round(Math.min(...fps)),
        }),
        averageTotalCpuPercent: round(average(totalCpu)),
        ...(ram.length > 0 && { peakRamMb: round(Math.max(...ram)) }),
        runTimeMs: Math.round(iteration.time),
    };
};

/**
 * Medians resist one cold-cache outlier; FPS floor and RAM peak keep the worst iteration visible.
 */
export const summarizeAndroidBenchmark = (
    iterations: AndroidBenchmarkIterationReceipt[],
): AndroidBenchmarkSummary => {
    if (iterations.length === 0) throw new Error('No successful benchmark iterations');
    const averageFps = iterations.flatMap((item) =>
        item.averageFps === undefined ? [] : [item.averageFps],
    );
    const minimumFps = iterations.flatMap((item) =>
        item.minimumFps === undefined ? [] : [item.minimumFps],
    );
    const peakRam = iterations.flatMap((item) =>
        item.peakRamMb === undefined ? [] : [item.peakRamMb],
    );
    return {
        ...(averageFps.length > 0 && { medianAverageFps: round(median(averageFps)) }),
        medianRunTimeMs: Math.round(median(iterations.map((item) => item.runTimeMs))),
        medianTotalCpuPercent: round(median(iterations.map((item) => item.averageTotalCpuPercent))),
        ...(peakRam.length > 0 && { peakRamMb: Math.max(...peakRam) }),
        ...(minimumFps.length > 0 && { worstMinimumFps: Math.min(...minimumFps) }),
    };
};
