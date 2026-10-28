import type { PtyUsage, ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { E2EPtyUsageOverride } from '../e2e-pty-usage-override';
import { PtyUsageMonitor } from '../pty-usage-monitor';

function createMonitor(
    reading: { bound?: number; current: PtyUsage | undefined },
    readingOverride?: E2EPtyUsageOverride,
) {
    const events: ServerEvent[] = [];
    const write = vi.fn();
    const sampleUsage = vi.fn(() => Promise.resolve(reading.current));
    let now = 0;
    const monitor = new PtyUsageMonitor({
        logger: { write } as never,
        now: () => (now += 10_000),
        readingOverride,
        sampleUpperBound: () =>
            Promise.resolve(
                reading.current && {
                    limit: reading.current.limit,
                    upperBound: reading.bound ?? reading.current.inUse,
                },
            ),
        sampleUsage,
        send: (event) => events.push(event),
        watchHub: { registerPoller: vi.fn() },
    });
    return { events, monitor, sampleUsage, write };
}

function usage(inUse: number, limit = 100): PtyUsage {
    return { inUse, limit, holders: [{ pid: 42, count: inUse }] };
}

function alerts(events: readonly ServerEvent[]) {
    return events.flatMap((event) => (event.event === 'terminal.ptyAlert' ? [event.payload] : []));
}

describe('PtyUsageMonitor', () => {
    it('skips the full holder scan while the device-node bound is under the alert share', async () => {
        const { events, monitor, sampleUsage } = createMonitor({ bound: 79, current: usage(10) });

        await monitor.sample();

        expect(sampleUsage).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });

    it('raises once at the alert share and clears only after use falls clearly below it', async () => {
        const reading = { current: usage(80) };
        const { events, monitor, write } = createMonitor(reading);

        await monitor.sample();
        reading.current = usage(90);
        await monitor.sample();
        reading.current = usage(76);
        await monitor.sample();
        reading.current = usage(74);
        await monitor.sample();

        expect(alerts(events)).toEqual([
            { state: 'raised', inUse: 80, limit: 100 },
            { state: 'cleared', inUse: 74, limit: 100 },
        ]);
        expect(write).toHaveBeenCalledWith('info', 'terminal.pty_alert_cleared', {
            durationMs: expect.any(Number) as number,
            fields: { limit: 100, peakInUse: 90, reason: 'recovered' },
        });
    });

    it('reports a still-raised episode as stopped when the Server closes', async () => {
        const { events, monitor, write } = createMonitor({ current: usage(95) });

        await monitor.sample();
        await monitor.close();

        expect(alerts(events).map((alert) => alert.state)).toEqual(['raised', 'cleared']);
        expect(write).toHaveBeenLastCalledWith('info', 'terminal.pty_alert_cleared', {
            durationMs: expect.any(Number) as number,
            fields: { limit: 100, peakInUse: 95, reason: 'stopped' },
        });
    });

    it('logs a failed sample instead of throwing from the poller', async () => {
        const { events, monitor, sampleUsage, write } = createMonitor({ current: usage(90) });
        sampleUsage.mockRejectedValueOnce(new Error('lsof timed out'));

        await monitor.sample();

        expect(events).toEqual([]);
        expect(write).toHaveBeenCalledWith('warn', 'terminal.pty_sample_failed', {
            fields: { error: 'lsof timed out' },
        });
    });

    it('answers Process Explorer with no reading instead of failing when the scan fails', async () => {
        const { monitor, sampleUsage } = createMonitor({ current: usage(10) });
        sampleUsage.mockRejectedValueOnce(new Error('lsof timed out'));

        await expect(monitor.usage()).resolves.toBeUndefined();
    });

    it('keeps an injected E2E reading when the real holder scan fails', async () => {
        const { events, monitor, sampleUsage } = createMonitor(
            { current: usage(10) },
            { intervalMs: 1_000, read: () => Promise.resolve({ inUse: 450, limit: 511 }) },
        );
        sampleUsage.mockRejectedValueOnce(new Error('lsof timed out'));

        await monitor.sample();

        expect(alerts(events)).toEqual([{ state: 'raised', inUse: 450, limit: 511 }]);
    });
});
