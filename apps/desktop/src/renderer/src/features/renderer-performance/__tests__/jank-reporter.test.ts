import type { RendererJankDiagnostic } from '@caxri/protocol';
import { rendererDiagnosticSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    bundleFileName,
    JANK_THRESHOLD_MS,
    RendererJankReporter,
    toSlowFrame,
} from '../jank-reporter';

function createReporter(options: { visible?: boolean } = {}) {
    let nowMs = 10_000;
    const reports: RendererJankDiagnostic[] = [];
    const timers: Array<{ callback: () => void; delayMs: number; fired: boolean }> = [];
    let ids = 0;
    const reporter = new RendererJankReporter({
        clearTimer: (handle) => {
            (handle as { fired: boolean }).fired = true;
        },
        isDocumentVisible: () => options.visible ?? true,
        newId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
        now: () => nowMs,
        report: (diagnostic) => reports.push(diagnostic),
        setTimer: (callback, delayMs) => {
            const timer = { callback, delayMs, fired: false };
            timers.push(timer);
            return timer;
        },
    });
    return {
        reporter,
        reports,
        timers,
        advance: (ms: number) => (nowMs += ms),
        fire: () => {
            const timer = timers.findLast((candidate) => !candidate.fired);
            if (!timer) return;
            timer.fired = true;
            timer.callback();
        },
    };
}

const slowSwitch = (startedAt: number, totalMs: number) => ({
    startedAt,
    repliedAt: startedAt + totalMs * 0.6,
    convergedAt: startedAt + totalMs * 0.9,
    paintedAt: startedAt + totalMs,
});

describe('Renderer jank reporter', () => {
    it('sends nothing for fast switches and short frames', () => {
        const { reporter, reports, timers } = createReporter();

        reporter.recordSessionSwitch(slowSwitch(0, JANK_THRESHOLD_MS - 1));
        reporter.recordFrame({ startTime: 0, duration: JANK_THRESHOLD_MS - 1 });

        expect(timers).toEqual([]);
        expect(reports).toEqual([]);
    });

    it('reports a slow switch split into request, converge, and paint time', () => {
        const { reporter, reports, fire, advance } = createReporter();

        reporter.recordSessionSwitch(slowSwitch(9_500, 400));
        advance(100);
        fire();

        expect(reports).toHaveLength(1);
        expect(reports[0]?.switches).toEqual([
            { totalMs: 400, requestMs: 240, convergeMs: 120, paintMs: 40, endedAgoMs: 200 },
        ]);
        expect(() => rendererDiagnosticSchema.parse(reports[0])).not.toThrow();
    });

    it('attributes the slowest script and marks a frame that overlapped a switch', () => {
        const { reporter, reports, fire } = createReporter();

        reporter.recordSessionSwitch(slowSwitch(1_000, 300));
        reporter.recordFrame({
            startTime: 1_050,
            duration: 180,
            blockingDuration: 130,
            styleAndLayoutStart: 1_190,
            scripts: [
                { duration: 20, invokerType: 'event-listener', sourceURL: 'app://x/assets/a.js' },
                {
                    duration: 95,
                    forcedStyleAndLayoutDuration: 30,
                    invokerType: 'user-callback',
                    sourceFunctionName: 'renderRows',
                    sourceURL: 'app://caxri/assets/index-ab12.js?v=3',
                },
            ],
        });
        fire();

        expect(reports[0]?.frames).toEqual([
            {
                durationMs: 180,
                blockingMs: 130,
                styleLayoutMs: 40,
                isDuringSessionSwitch: true,
                scriptCount: 2,
                endedAgoMs: 8_770,
                topScript: {
                    invokerType: 'user-callback',
                    durationMs: 95,
                    forcedStyleLayoutMs: 30,
                    file: 'index-ab12.js',
                    functionName: 'renderRows',
                },
            },
        ]);
        expect(() => rendererDiagnosticSchema.parse(reports[0])).not.toThrow();
    });

    it('marks a frame delivered before its switch finished, and treats a zero layout start as absent', () => {
        const { reporter, reports, fire } = createReporter();

        reporter.recordFrame({ startTime: 1_100, duration: 150, styleAndLayoutStart: 0 });
        reporter.recordSessionSwitch(slowSwitch(1_000, 400));
        fire();

        expect(reports[0]?.frames[0]).toMatchObject({
            isDuringSessionSwitch: true,
            styleLayoutMs: 0,
        });
    });

    it('does not let a visibility flush beat the minimum interval', () => {
        const { reporter, reports, advance, fire } = createReporter();

        reporter.recordFrame({ startTime: 0, duration: 200 });
        fire();
        advance(1_000);
        reporter.recordFrame({ startTime: 0, duration: 200 });
        reporter.flushIfDue();
        expect(reports).toHaveLength(1);

        advance(10_000);
        reporter.flushIfDue();
        expect(reports).toHaveLength(2);
    });

    it('ignores frames while the window is hidden', () => {
        const { reporter, timers } = createReporter({ visible: false });

        reporter.recordFrame({ startTime: 0, duration: 500 });

        expect(timers).toEqual([]);
    });

    it('keeps the slowest samples of a burst and counts the rest', () => {
        const { reporter, reports, fire } = createReporter();

        for (const duration of [110, 120, 130, 140, 150, 900, 105]) {
            reporter.recordFrame({ startTime: 5_000, duration });
        }
        fire();

        const frame = reports[0]?.frames
            .map((candidate) => candidate.durationMs)
            .toSorted((left, right) => left - right);
        expect(frame).toEqual([120, 130, 140, 150, 900]);
        expect(reports[0]?.omittedFrameCount).toBe(2);
    });

    it('delays the next batch until the minimum interval has passed', () => {
        const { reporter, reports, timers, fire, advance } = createReporter();

        reporter.recordFrame({ startTime: 0, duration: 200 });
        fire();
        advance(1_000);
        reporter.recordFrame({ startTime: 0, duration: 200 });

        expect(reports).toHaveLength(1);
        expect(timers.at(-1)?.delayMs).toBe(9_000);
        fire();
        expect(reports).toHaveLength(2);
    });

    it('drops script locations that are not plain bundle names', () => {
        expect(bundleFileName('app://caxri/assets/index-ab12.js?x=1')).toBe('index-ab12.js');
        expect(bundleFileName('file:///Users/someone/My Project.js')).toBeNull();
        expect(bundleFileName(undefined)).toBeNull();
        expect(
            toSlowFrame(
                { startTime: 0, duration: 120, scripts: [{ duration: 5, invokerType: 'weird' }] },
                false,
            ).topScript?.invokerType,
        ).toBe('unknown');
    });
});
