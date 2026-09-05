import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogRecord } from '../../observability/logger';
import { EVENT_LOOP_STALL_EVENT, startEventLoopMonitor } from '../event-loop-monitor';

interface Sample {
    level: LogRecord['level'];
    event: string;
    durationMs?: number;
    fields?: LogRecord['fields'];
}

const PROBE_INTERVAL_MS = 500;
const PROBE_WARN_MS = 250;

/**
 * Drives the monitor over a stubbed clock and stubbed CPU accounting so a suspended window and a genuinely blocked
 * window can be produced exactly, without waiting on either one in real time.
 */
function createStubbedProbe() {
    const samples: Sample[] = [];
    let nowMs = 0;
    let cpuMicroseconds = 0;
    const stop = startEventLoopMonitor(
        { write: (level, event, options) => samples.push({ level, event, ...options }) },
        {
            cpuUsage: () => ({ user: cpuMicroseconds, system: 0 }),
            intervalMs: PROBE_INTERVAL_MS,
            now: () => nowMs,
            warnMs: PROBE_WARN_MS,
        },
    );
    return {
        samples,
        stop,
        /**
         * Fires one probe after `elapsedMs` of wall-clock time during which the process consumed `cpuMs` of CPU.
         */
        tick(elapsedMs: number, cpuMs: number) {
            nowMs += elapsedMs;
            cpuMicroseconds += cpuMs * 1000;
            vi.advanceTimersByTime(PROBE_INTERVAL_MS);
        },
    };
}

function burnCpu(milliseconds: number): void {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline);
}

describe('event-loop stall monitor', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('stays silent for a window that arrives on schedule', () => {
        vi.useFakeTimers();
        const probe = createStubbedProbe();
        try {
            probe.tick(PROBE_INTERVAL_MS, PROBE_INTERVAL_MS);
            probe.tick(PROBE_INTERVAL_MS + 100, 600);

            expect(probe.samples).toEqual([]);
        } finally {
            probe.stop();
        }
    });

    it('escalates a blocked window whose CPU time matches the gap', () => {
        vi.useFakeTimers();
        const probe = createStubbedProbe();
        try {
            probe.tick(PROBE_INTERVAL_MS, PROBE_INTERVAL_MS);
            probe.tick(3500, 3500);

            expect(probe.samples).toEqual([
                {
                    level: 'error',
                    event: EVENT_LOOP_STALL_EVENT,
                    durationMs: 3000,
                    fields: {
                        probeIntervalMs: PROBE_INTERVAL_MS,
                        cpuDeltaMs: 3500,
                        stallKind: 'event-loop-block',
                    },
                },
            ]);
        } finally {
            probe.stop();
        }
    });

    /**
     * The reported defect: a closed lid freezes the whole process, so the first probe after wake measures the entire
     * sleep as one gap. Without the CPU criterion every wake produced an `error`.
     */
    it('reports a suspended window as an informational non-fault', () => {
        vi.useFakeTimers();
        const probe = createStubbedProbe();
        try {
            probe.tick(PROBE_INTERVAL_MS, PROBE_INTERVAL_MS);
            probe.tick(3500, 4);

            expect(probe.samples).toEqual([
                {
                    level: 'info',
                    event: EVENT_LOOP_STALL_EVENT,
                    durationMs: 3000,
                    fields: {
                        probeIntervalMs: PROBE_INTERVAL_MS,
                        cpuDeltaMs: 4,
                        stallKind: 'process-suspension',
                    },
                },
            ]);
        } finally {
            probe.stop();
        }
    });

    it('treats any gap past the ceiling as a suspension even when CPU accounting kept advancing', () => {
        vi.useFakeTimers();
        const probe = createStubbedProbe();
        try {
            probe.tick(PROBE_INTERVAL_MS, PROBE_INTERVAL_MS);
            probe.tick(60_000, 60_000);

            expect(probe.samples[0]).toMatchObject({
                level: 'info',
                fields: { stallKind: 'process-suspension' },
            });
        } finally {
            probe.stop();
        }
    });

    it('classifies a real synchronous block through the production clock and CPU seams', async () => {
        const samples: Sample[] = [];
        const stop = startEventLoopMonitor(
            { write: (level, event, options) => samples.push({ level, event, ...options }) },
            { intervalMs: 5, warnMs: 10 },
        );
        try {
            burnCpu(150);
            await vi.waitFor(() => expect(samples.length).toBeGreaterThan(0));
            const stall = samples[0];
            expect(stall.event).toBe(EVENT_LOOP_STALL_EVENT);
            expect(stall.level).toBe('error');
            expect(stall.durationMs).toBeGreaterThanOrEqual(100);
            expect(stall.fields).toMatchObject({
                probeIntervalMs: 5,
                stallKind: 'event-loop-block',
            });
        } finally {
            stop();
        }
    });
});
