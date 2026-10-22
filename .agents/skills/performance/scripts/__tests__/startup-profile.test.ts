import { describe, expect, it } from 'vitest';

import {
    lastRecord,
    median,
    parseProfileSeed,
    percentile,
    summarizeStartupRuns,
} from '../startup-profile';

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
        expect(summary.warmP95).toEqual({ 'firstFrameMs': 900, 'server.readyMs': 300 });
    });

    it('reports a nearest-rank percentile that was actually observed', () => {
        expect(percentile([], 95)).toBeUndefined();
        expect(percentile([5], 95)).toBe(5);
        expect(percentile([10, 40, 20, 30], 95)).toBe(40);
        expect(percentile([10, 40, 20, 30], 50)).toBe(20);
    });

    it('accepts a seed only when every Session can own a Terminal', () => {
        expect(parseProfileSeed(undefined)).toBeUndefined();
        expect(parseProfileSeed('175,245,201,253')).toEqual({
            projects: 175,
            sessions: 245,
            archived: 201,
            terminals: 253,
        });
        expect(() => parseProfileSeed('175,245,201')).toThrow(
            'projects,sessions,archived,terminals',
        );
        expect(() => parseProfileSeed('0,1,0,1')).toThrow('needs a Project');
        expect(() => parseProfileSeed('1,2,3,4')).toThrow('archived <= sessions');
        expect(() => parseProfileSeed('1,2,0,1')).toThrow('terminals >= sessions');
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
