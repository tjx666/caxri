import { performance } from 'node:perf_hooks';
import process from 'node:process';

import type { LogEventName } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';

import type { LogRecord } from '../observability/logger.js';

export interface EventLoopMonitorSink {
    write(
        level: LogRecord['level'],
        event: LogEventName,
        options?: Pick<LogRecord, 'correlationId' | 'durationMs' | 'fields'>,
    ): void;
}

export const EVENT_LOOP_STALL_EVENT = logEventCatalog.process.eventLoopStall;

/**
 * Default probe cadence and reporting threshold: a stall is only interesting once it is long enough to make IPC feel
 * unresponsive, and the 500ms probe keeps the monitor itself invisible in profiles.
 */
const EVENT_LOOP_MONITOR_INTERVAL_MS = 500;
const EVENT_LOOP_STALL_WARN_MS = 250;
/**
 * A stall this many times the warn threshold escalates to `error` — at that point requests are visibly timing out.
 */
const ERROR_ESCALATION_FACTOR = 10;
/**
 * A gap this long is always a suspension. No single synchronous task in this process runs for ten seconds, while a
 * closed lid trivially exceeds it, so the ceiling classifies the extreme case without depending on CPU accounting.
 */
const SUSPENSION_CEILING_MS = 10_000;
/**
 * Below this fraction of the gap, consumed CPU time is too small for the process to have been running: a synchronous
 * task that blocks the loop for N milliseconds burns roughly N milliseconds of CPU, whereas a suspended process burns
 * none because it never got scheduled.
 */
const SUSPENSION_CPU_RATIO = 0.1;

/**
 * Why the gap happened. `process-suspension` is an expected non-fault — the whole process was frozen by the OS, most
 * often a macOS lid close — and never escalates, so the `error` count keeps its signal value. `event-loop-block` is the
 * real defect this monitor exists to catch.
 */
export type EventLoopStallKind = 'event-loop-block' | 'process-suspension';

export interface EventLoopMonitorOptions {
    /**
     * Test seam for process CPU accounting; production uses `process.cpuUsage`.
     */
    cpuUsage?: () => NodeJS.CpuUsage;
    intervalMs?: number;
    /**
     * Test seam for the monotonic clock; production uses `performance.now`.
     */
    now?: () => number;
    warnMs?: number;
}

function stallLevel(kind: EventLoopStallKind, stallMs: number, warnMs: number): LogRecord['level'] {
    if (kind === 'process-suspension') return 'info';
    return stallMs >= warnMs * ERROR_ESCALATION_FACTOR ? 'error' : 'warn';
}

/**
 * Logs one structured record per event-loop gap. A frozen loop previously left only a silence window in the logs, so
 * freezes had to be inferred from unrelated requests completing on the same millisecond; this timer makes the gap
 * itself a first-class, timestamped record with its magnitude. Timer-based rather than `monitorEventLoopDelay` so each
 * gap is attributable to a wall-clock moment instead of a histogram. The timer is unref'd and never keeps the process
 * alive.
 *
 * Each probe also samples `process.cpuUsage` so an OS-level process suspension is separated from a genuine block; see
 * {@link EventLoopStallKind}. Comparing `performance.now()` against `Date.now()` cannot make that distinction, because
 * libuv has used `mach_continuous_time()` on macOS since 1.39 and that clock keeps advancing across system sleep, so
 * the two never diverge.
 *
 * Known limitation of the CPU criterion: a loop parked in a blocking syscall also consumes almost no CPU and is
 * therefore reported as a suspension. Process suspension is by far the dominant producer of multi-second gaps here, and
 * no cheap in-process signal separates the two.
 */
export function startEventLoopMonitor(
    sink: EventLoopMonitorSink,
    options: EventLoopMonitorOptions = {},
): () => void {
    const intervalMs = options.intervalMs ?? EVENT_LOOP_MONITOR_INTERVAL_MS;
    const warnMs = options.warnMs ?? EVENT_LOOP_STALL_WARN_MS;
    const readNow = options.now ?? (() => performance.now());
    const readCpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    let expectedAt = readNow() + intervalMs;
    let lastCpuUsage = readCpuUsage();
    const timer = setInterval(() => {
        const now = readNow();
        const cpuUsage = readCpuUsage();
        const stallMs = now - expectedAt;
        const cpuDeltaMs =
            (cpuUsage.user - lastCpuUsage.user + (cpuUsage.system - lastCpuUsage.system)) / 1000;
        expectedAt = now + intervalMs;
        lastCpuUsage = cpuUsage;
        if (stallMs < warnMs) return;
        const kind: EventLoopStallKind =
            stallMs >= SUSPENSION_CEILING_MS || cpuDeltaMs < stallMs * SUSPENSION_CPU_RATIO
                ? 'process-suspension'
                : 'event-loop-block';
        sink.write(stallLevel(kind, stallMs, warnMs), EVENT_LOOP_STALL_EVENT, {
            durationMs: Math.round(stallMs),
            fields: {
                probeIntervalMs: intervalMs,
                cpuDeltaMs: Math.round(cpuDeltaMs),
                stallKind: kind,
            },
        });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
