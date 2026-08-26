import { describe, expect, it, vi } from 'vitest';

import type { LogRecord } from '../../observability/logger';
import { EVENT_LOOP_STALL_EVENT, startEventLoopMonitor } from '../event-loop-monitor';

interface Sample {
    level: LogRecord['level'];
    event: string;
    durationMs?: number;
    fields?: LogRecord['fields'];
}

function blockEventLoop(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

describe('event-loop stall monitor', () => {
    it('logs a stall with its magnitude and stays silent while the loop is healthy', async () => {
        const samples: Sample[] = [];
        const stop = startEventLoopMonitor(
            { write: (level, event, options) => samples.push({ level, event, ...options }) },
            { intervalMs: 10, warnMs: 20 },
        );
        try {
            blockEventLoop(80);
            await vi.waitFor(() => expect(samples.length).toBeGreaterThan(0));
            const stall = samples[0];
            expect(stall.event).toBe(EVENT_LOOP_STALL_EVENT);
            expect(stall.level).toBe('warn');
            expect(stall.durationMs).toBeGreaterThanOrEqual(40);
            expect(stall.fields).toEqual({ probeIntervalMs: 10 });

            samples.length = 0;
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(samples).toEqual([]);
        } finally {
            stop();
        }
    });

    it('escalates an extreme stall to error', async () => {
        const samples: Sample[] = [];
        const stop = startEventLoopMonitor(
            { write: (level, event, options) => samples.push({ level, event, ...options }) },
            { intervalMs: 5, warnMs: 10 },
        );
        try {
            blockEventLoop(150);
            await vi.waitFor(() => expect(samples.length).toBeGreaterThan(0));
            expect(samples[0].level).toBe('error');
        } finally {
            stop();
        }
    });
});
