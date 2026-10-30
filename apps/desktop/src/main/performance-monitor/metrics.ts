import type { PerformanceMonitorMetrics, PerformanceMonitorProcessRole } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import type { ElectronProcessSample } from '../process-explorer/sampler';
import { kilobytesToMegabytes } from '../process-explorer/sampler';

/**
 * How long a `getAppMetrics()` reading is reused. Electron reports CPU relative to the previous call, so a second
 * poller reading the same API mid-interval would shrink every window's CPU span and make both look idle or spiky.
 * Process Explorer polls every two seconds and the monitor does too; sharing one reading inside this window keeps the
 * two views agreeing instead of fighting over the delta.
 */
const SHARED_READING_TTL_MS = 1_500;

/**
 * Wraps the Electron process read so concurrent consumers (Process Explorer, Performance Monitor) share one reading per
 * {@link SHARED_READING_TTL_MS}. The first call after startup returns CPU zeros; that is Electron's own behaviour.
 */
export function createSharedProcessReader(
    read: () => ElectronProcessSample[],
    now: () => number = Date.now,
): () => ElectronProcessSample[] {
    let cached: { at: number; samples: ElectronProcessSample[] } | undefined;
    return () => {
        const at = now();
        if (cached && at >= cached.at && at - cached.at < SHARED_READING_TTL_MS)
            return cached.samples;
        cached = { at, samples: read() };
        return cached.samples;
    };
}

/**
 * The one `getGPUFeatureStatus()` key the monitor reads; Electron's own status type is assignable to it.
 */
export interface GpuFeatureStatus {
    rasterization?: unknown;
}

/**
 * Reads `getGPUFeatureStatus().rasterization` the way Chromium's own HUD line "GPU raster" does: any `enabled*` value
 * means hardware rasterization is on, any other string (`disabled_software`, `unavailable_off`, ...) means it is off,
 * and a missing key (an Electron that renamed it) is reported as unknown rather than guessed.
 */
export function gpuRasterState(status: GpuFeatureStatus): PerformanceMonitorMetrics['gpuRaster'] {
    const raw = status.rasterization;
    if (typeof raw !== 'string') return { state: 'unknown', raw: '' };
    const trimmed = raw.slice(0, 64);
    return { state: trimmed.startsWith('enabled') ? 'on' : 'off', raw: trimmed };
}

interface ProcessReading {
    cpuPercent: number;
    memoryMb: number;
}

const ROLE_ORDER: readonly PerformanceMonitorProcessRole[] = [
    'workbench',
    'gpu',
    'browser',
    'server',
    'other',
];

function roleOf(
    sample: ElectronProcessSample,
    workbenchPid: number | undefined,
): PerformanceMonitorProcessRole {
    if (sample.type === 'GPU') return 'gpu';
    if (sample.type === 'Browser') return 'browser';
    if (sample.type === 'Tab' && sample.pid === workbenchPid) return 'workbench';
    return 'other';
}

/**
 * Collapses Electron's process list into the few roles a person asks about. `workbenchPid` is the monitored window's
 * Renderer; every other Renderer or utility process folds into `other` so the rows stay few and stable.
 */
export function summarizeProcesses(
    samples: readonly ElectronProcessSample[],
    workbenchPid: number | undefined,
    server: ProcessReading | undefined,
): PerformanceMonitorMetrics['processes'] {
    const totals = new Map<PerformanceMonitorProcessRole, ProcessReading>();
    const add = (role: PerformanceMonitorProcessRole, reading: ProcessReading): void => {
        const previous = totals.get(role) ?? { cpuPercent: 0, memoryMb: 0 };
        totals.set(role, {
            cpuPercent: previous.cpuPercent + reading.cpuPercent,
            memoryMb: previous.memoryMb + reading.memoryMb,
        });
    };
    for (const sample of samples) add(roleOf(sample, workbenchPid), sample);
    if (server) add('server', server);
    return ROLE_ORDER.flatMap((role) => {
        const reading = totals.get(role);
        if (!reading) return [];
        return [
            {
                role,
                cpuPercent: Math.round(reading.cpuPercent * 10) / 10,
                memoryMb: Math.round(reading.memoryMb * 10) / 10,
            },
        ];
    });
}

/**
 * Reads one process's CPU and resident memory from `ps`. Server Core is not an Electron process, so `getAppMetrics()`
 * cannot see it; the answer is `undefined` when the process is gone or `ps` fails.
 */
export async function readServerProcess(pid: number): Promise<ProcessReading | undefined> {
    try {
        const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pcpu=,rss=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 1_000,
        });
        const fields = stdout.trim().split(/\s+/);
        const cpu = Number(fields[0]);
        const rss = Number(fields[1]);
        if (fields.length < 2 || !Number.isFinite(cpu) || !Number.isFinite(rss)) return undefined;
        return { cpuPercent: cpu, memoryMb: kilobytesToMegabytes(rss) };
    } catch {
        return undefined;
    }
}
