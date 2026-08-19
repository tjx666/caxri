import { performance } from 'node:perf_hooks';

import type { LogRecord } from './logger';

export interface EventLoopMonitorSink {
    write(
        level: LogRecord['level'],
        event: string,
        options?: Pick<LogRecord, 'correlationId' | 'durationMs' | 'fields'>,
    ): void;
}

export const EVENT_LOOP_STALL_EVENT = 'process.event_loop_stall';

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

export interface EventLoopMonitorOptions {
    intervalMs?: number;
    warnMs?: number;
}

/**
 * Logs one structured record per event-loop stall. A frozen loop (sync IO, native call, process suspension) previously
 * left only a silence window in the logs, so freezes had to be inferred from unrelated requests completing on the same
 * millisecond; this timer makes the stall itself a first-class, timestamped record with its magnitude. Timer-based
 * rather than `monitorEventLoopDelay` so each stall is attributable to a wall-clock moment instead of a histogram. The
 * timer is unref'd and never keeps the process alive.
 */
export function startEventLoopMonitor(
    sink: EventLoopMonitorSink,
    options: EventLoopMonitorOptions = {},
): () => void {
    const intervalMs = options.intervalMs ?? EVENT_LOOP_MONITOR_INTERVAL_MS;
    const warnMs = options.warnMs ?? EVENT_LOOP_STALL_WARN_MS;
    let expectedAt = performance.now() + intervalMs;
    const timer = setInterval(() => {
        const now = performance.now();
        const stallMs = now - expectedAt;
        if (stallMs >= warnMs) {
            sink.write(
                stallMs >= warnMs * ERROR_ESCALATION_FACTOR ? 'error' : 'warn',
                EVENT_LOOP_STALL_EVENT,
                { durationMs: Math.round(stallMs), fields: { probeIntervalMs: intervalMs } },
            );
        }
        expectedAt = now + intervalMs;
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
