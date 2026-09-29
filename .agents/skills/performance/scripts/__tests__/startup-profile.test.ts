import { describe, expect, it } from 'vitest';

import { lastRecord, median, summarizeStartupRuns } from '../startup-profile';

describe('startup profile runner', () => {
    it('takes the median of odd and even sample counts', () => {
        expect(median([])).toBeUndefined();
        expect(median([30, 10, 20])).toBe(20);
        expect(median([40, 10, 30, 20])).toBe(25);
    });

    it('reports the first launch apart from the warm median', () => {
        const summary = summarizeStartupRuns([
            { firstFrameMs: 2000 },
            { 'firstFrameMs': 900, 'server.readyMs': 300 },
            { firstFrameMs: 700 },
            { 'firstFrameMs': 800, 'server.readyMs': 200 },
        ]);

        expect(summary.first).toEqual({ firstFrameMs: 2000 });
        expect(summary.warmRuns).toBe(3);
        expect(summary.warmMedian).toEqual({ 'firstFrameMs': 800, 'server.readyMs': 250 });
    });

    it('reads the newest complete record of an event and skips a partial line', () => {
        const contents = [
            '{"event":"app.startup_profile","fields":{"firstFrameMs":1}}',
            '{"event":"app.ready"}',
            '{"event":"app.startup_profile","fields":{"firstFrameMs":2}}',
            '{"event":"app.startup_pro',
        ].join('\n');

        expect(lastRecord(contents, 'app.startup_profile')?.fields).toEqual({ firstFrameMs: 2 });
        expect(lastRecord(contents, 'server_core.ready')).toBeUndefined();
    });
});
