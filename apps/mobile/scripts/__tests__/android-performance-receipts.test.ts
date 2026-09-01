import { describe, expect, it } from 'vitest';

import { parseAndroidActivityStart, parseAndroidFrameStats } from '../android-performance-receipts';

describe('Android performance receipts', () => {
    it('parses the bounded Activity launch fields without retaining Intent data', () => {
        expect(
            parseAndroidActivityStart(
                'Starting: Intent { dat=private }\r\nStatus: ok\r\nLaunchState: COLD\r\nActivity: com.caxri.mobile/.MainActivity\r\nTotalTime: 1250\r\nWaitTime: 1275\r\nComplete\r\n',
            ),
        ).toEqual({ launchState: 'COLD', totalTimeMs: 1_250, waitTimeMs: 1_275 });
    });

    it('parses current frame statistics and ignores the legacy duplicate', () => {
        expect(
            parseAndroidFrameStats(`Total frames rendered: 200
Janky frames: 6 (3.00%)
Janky frames (legacy): 190 (95.00%)
50th percentile: 12ms
90th percentile: 20ms
95th percentile: 24ms
99th percentile: 40ms`),
        ).toEqual({
            droppedFrameRatio: 0.03,
            jankyFrames: 6,
            percentile50Ms: 12,
            percentile90Ms: 20,
            percentile95Ms: 24,
            percentile99Ms: 40,
            totalFrames: 200,
        });
    });

    it('keeps the warm foreground wait when Android omits TotalTime', () => {
        expect(
            parseAndroidActivityStart(
                'Status: ok\r\nLaunchState: UNKNOWN (0)\r\nWaitTime: 42\r\nComplete\r\n',
            ),
        ).toEqual({ launchState: 'UNKNOWN', waitTimeMs: 42 });
    });

    it('fails closed when required Android fields are absent', () => {
        expect(() => parseAndroidActivityStart('Status: timeout')).toThrow(
            'Android Activity launch did not report success',
        );
        expect(() => parseAndroidFrameStats('Total frames rendered: 1')).toThrow(
            'Android performance output is missing jankyFrames',
        );
    });

    it('bounds ratio precision for stable JSON receipts', () => {
        expect(
            parseAndroidFrameStats(`Total frames rendered: 77
Janky frames: 15 (19.48%)
50th percentile: 19ms
90th percentile: 32ms
95th percentile: 48ms
99th percentile: 550ms`).droppedFrameRatio,
        ).toBe(0.1948);
    });
});
