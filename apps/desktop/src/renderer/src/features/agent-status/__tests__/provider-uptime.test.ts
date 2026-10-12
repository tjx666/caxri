import { describe, expect, it } from 'vitest';

import { formatUptimePercent, providerUptimeDays } from '../provider-uptime';

function at(year: number, month: number, day: number, hour = 0): number {
    return new Date(year, month - 1, day, hour).getTime();
}

describe('providerUptimeDays', () => {
    it('colors each local day by its worst overlapping impact, oldest first', () => {
        const windowEnd = at(2026, 3, 10, 15);
        const days = providerUptimeDays(
            {
                windowStart: at(2026, 3, 1),
                windowEnd,
                impacts: [
                    { startAt: at(2026, 3, 8, 23), endAt: at(2026, 3, 9, 1), status: 'degraded' },
                    {
                        startAt: at(2026, 3, 9, 5),
                        endAt: at(2026, 3, 9, 6),
                        status: 'partialOutage',
                    },
                    { startAt: at(2026, 3, 10, 14), status: 'majorOutage' },
                ],
            },
            4,
        );
        expect(days).toEqual([
            { start: at(2026, 3, 7), status: 'operational' },
            { start: at(2026, 3, 8), status: 'degraded' },
            { start: at(2026, 3, 9), status: 'partialOutage' },
            { start: at(2026, 3, 10), status: 'majorOutage' },
        ]);
    });

    it('marks days before the page started recording the component as no data', () => {
        const days = providerUptimeDays(
            {
                windowStart: at(2026, 3, 1),
                windowEnd: at(2026, 3, 10, 12),
                dataAvailableSince: at(2026, 3, 9, 8),
                impacts: [],
            },
            3,
        );
        expect(days.map((day) => day.status)).toEqual(['noData', 'operational', 'operational']);
    });
});

describe('formatUptimePercent', () => {
    it('drops trailing zeros the way the status page prints the figure', () => {
        expect(formatUptimePercent(99.95)).toBe('99.95');
        expect(formatUptimePercent(100)).toBe('100');
    });
});
