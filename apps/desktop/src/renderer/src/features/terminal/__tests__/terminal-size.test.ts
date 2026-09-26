import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    didTerminalSizeChange,
    TerminalPaneResizeController,
    TerminalResizeBurstTracker,
    TerminalResizeSettler,
} from '../terminal-size';

afterEach(() => {
    vi.useRealTimers();
});

describe('Terminal resize deduplication', () => {
    it('applies a renderer-driven grid change and synchronizes it with the running PTY once', () => {
        let current = { cols: 135, rows: 59 };
        const apply = vi.fn((size: { cols: number; rows: number }) => {
            current = size;
        });
        const request = vi.fn(() => Promise.resolve());
        const controller = new TerminalPaneResizeController({
            apply,
            current: () => current,
            fitted: vi.fn(),
            isRunning: () => true,
            propose: () => ({ cols: 131, rows: 59 }),
            request,
            terminalId: 'terminal-gpu-recovery',
        });
        controller.confirmSent({ cols: 135, rows: 59 });

        controller.fitAndResize();
        controller.fitAndResize();

        expect(apply).toHaveBeenCalledOnce();
        expect(apply).toHaveBeenCalledWith({ cols: 131, rows: 59 });
        expect(request).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith({ cols: 131, rows: 59 });
    });

    it('displays the mobile PTY grid while caching the latest desktop fit for release', () => {
        let current = { cols: 80, rows: 24 };
        let proposed = { cols: 80, rows: 24 };
        const apply = vi.fn((size: { cols: number; rows: number }) => {
            current = size;
        });
        const fitted = vi.fn();
        const request = vi.fn(() => Promise.resolve());
        const controller = new TerminalPaneResizeController({
            apply,
            current: () => current,
            fitted,
            isRunning: () => true,
            propose: () => proposed,
            request,
            terminalId: 'terminal-mobile-size',
        });
        controller.confirmSent(proposed);

        controller.setSizeOwnership('mobile', { cols: 42, rows: 20 });
        expect(current).toEqual({ cols: 42, rows: 20 });
        expect(fitted).toHaveBeenLastCalledWith({ cols: 42, rows: 20 });

        proposed = { cols: 110, rows: 32 };
        controller.fitAndResize();
        expect(current).toEqual({ cols: 42, rows: 20 });
        expect(request).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith({ cols: 110, rows: 32 });
        expect(fitted).toHaveBeenLastCalledWith({ cols: 42, rows: 20 });

        controller.setSizeOwnership('mobile', { cols: 40, rows: 18 });
        expect(current).toEqual({ cols: 40, rows: 18 });
        controller.setSizeOwnership('desktop', { cols: 110, rows: 32 });
        expect(current).toEqual({ cols: 110, rows: 32 });
        expect(request).toHaveBeenCalledOnce();
        expect(fitted).toHaveBeenLastCalledWith({ cols: 110, rows: 32 });
    });

    it('drops stale mobile ownership before reattaching to a restarted Server', () => {
        let current = { cols: 80, rows: 24 };
        const controller = new TerminalPaneResizeController({
            apply: (size) => {
                current = size;
            },
            current: () => current,
            fitted: vi.fn(),
            isRunning: () => true,
            propose: () => ({ cols: 110, rows: 32 }),
            request: vi.fn(() => Promise.resolve()),
            terminalId: 'terminal-restarted-mobile-size',
        });
        controller.setSizeOwnership('mobile', { cols: 42, rows: 20 });

        controller.resetSizeOwnership();

        expect(current).toEqual({ cols: 110, rows: 32 });
    });

    it('suppresses an unchanged grid while preserving either dimension change', () => {
        expect(didTerminalSizeChange(undefined, { cols: 100, rows: 30 })).toBe(true);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 101, rows: 30 })).toBe(true);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 100, rows: 31 })).toBe(true);
    });

    it('keeps sampling after an initial narrow layout so the final pane grid is applied', () => {
        const frames: Array<() => void> = [];
        const requestFrame = vi.fn((callback: () => void) => {
            frames.push(callback);
            return frames.length;
        });
        const cancelFrame = vi.fn();
        const sampledColumns = [4, 4, 80, 80];
        const appliedColumns: number[] = [];
        const settler = new TerminalResizeSettler(
            () => appliedColumns.push(sampledColumns.shift() ?? 80),
            requestFrame,
            cancelFrame,
            4,
        );

        settler.schedule();
        while (frames.length > 0) frames.shift()!();

        expect(appliedColumns).toEqual([4, 4, 80, 80]);
        expect(requestFrame).toHaveBeenCalledTimes(4);
        expect(cancelFrame).not.toHaveBeenCalled();
    });

    it('keeps the recorded grid fixed while snapshot replay is active', () => {
        const frames: Array<() => void> = [];
        const requestFrame = vi.fn((callback: () => void) => {
            frames.push(callback);
            return frames.length;
        });
        const cancelFrame = vi.fn();
        const onFrame = vi.fn();
        const settler = new TerminalResizeSettler(onFrame, requestFrame, cancelFrame, 2);

        settler.schedule();
        settler.pause();
        settler.schedule();
        frames.shift()!();

        expect(cancelFrame).toHaveBeenCalledWith(1);
        expect(onFrame).not.toHaveBeenCalled();
        expect(requestFrame).toHaveBeenCalledTimes(1);

        settler.resume();
        frames.shift()!();

        expect(onFrame).toHaveBeenCalledTimes(1);
        expect(requestFrame).toHaveBeenCalledTimes(3);
    });
});

describe('Terminal resize burst diagnostics', () => {
    it('reports one bounded summary after the grid has been quiet for 250ms', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const emit = vi.fn();
        const tracker = new TerminalResizeBurstTracker({ emit, now: Date.now });

        tracker.sample({ cols: 153, rows: 59 }, { localApplied: false, requestSent: false });
        vi.advanceTimersByTime(10);
        tracker.sample({ cols: 4, rows: 59 }, { localApplied: true, requestSent: true });
        vi.advanceTimersByTime(10);
        tracker.sample({ cols: 4, rows: 59 }, { localApplied: false, requestSent: false });
        vi.advanceTimersByTime(10);
        tracker.sample({ cols: 80, rows: 59 }, { localApplied: true, requestSent: true });

        vi.advanceTimersByTime(249);
        expect(emit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith({
            sampleCount: 4,
            changeCount: 2,
            startCols: 153,
            startRows: 59,
            minCols: 4,
            minRows: 59,
            maxCols: 153,
            maxRows: 59,
            finalCols: 80,
            finalRows: 59,
            durationMs: 30,
            flushReason: 'quiet',
            truncated: false,
            localAppliedCount: 2,
            requestCount: 2,
        });
    });

    it('omits stable observations that caused neither a local resize nor a Server request', () => {
        vi.useFakeTimers();
        const emit = vi.fn();
        const tracker = new TerminalResizeBurstTracker({ emit, now: Date.now });

        tracker.sample({ cols: 80, rows: 59 }, { localApplied: false, requestSent: false });
        vi.advanceTimersByTime(100);
        tracker.sample({ cols: 80, rows: 59 }, { localApplied: false, requestSent: false });
        vi.advanceTimersByTime(250);

        expect(emit).not.toHaveBeenCalled();
    });

    it('splits a continuously changing burst after five seconds', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const emit = vi.fn();
        const tracker = new TerminalResizeBurstTracker({ emit, now: Date.now });

        tracker.sample({ cols: 80, rows: 59 }, { localApplied: true, requestSent: true });
        for (let index = 1; index <= 24; index += 1) {
            vi.advanceTimersByTime(200);
            tracker.sample(
                { cols: index % 2 === 0 ? 80 : 81, rows: 59 },
                { localApplied: true, requestSent: true },
            );
        }

        expect(emit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(200);
        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenLastCalledWith(
            expect.objectContaining({ flushReason: 'max-duration' }),
        );

        tracker.sample({ cols: 82, rows: 59 }, { localApplied: true, requestSent: true });
        vi.advanceTimersByTime(250);
        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sampleCount: 1,
                finalCols: 82,
                flushReason: 'quiet',
            }),
        );
    });

    it('flushes pending evidence on pause and dispose without a later duplicate', () => {
        vi.useFakeTimers();
        const pausedEmit = vi.fn();
        const paused = new TerminalResizeBurstTracker({ emit: pausedEmit, now: Date.now });
        paused.sample({ cols: 4, rows: 59 }, { localApplied: true, requestSent: true });

        paused.pause();
        expect(pausedEmit).toHaveBeenCalledWith(
            expect.objectContaining({ finalCols: 4, flushReason: 'paused' }),
        );
        paused.dispose();
        vi.advanceTimersByTime(250);
        expect(pausedEmit).toHaveBeenCalledOnce();

        const disposedEmit = vi.fn();
        const disposed = new TerminalResizeBurstTracker({ emit: disposedEmit, now: Date.now });
        disposed.sample({ cols: 80, rows: 59 }, { localApplied: true, requestSent: true });

        disposed.dispose();
        expect(disposedEmit).toHaveBeenCalledWith(
            expect.objectContaining({ finalCols: 80, flushReason: 'disposed' }),
        );
        vi.advanceTimersByTime(250);
        expect(disposedEmit).toHaveBeenCalledOnce();
    });

    it('seeds a later burst from the previously reported grid so a one-step resize reads as a change', () => {
        vi.useFakeTimers();
        const emit = vi.fn();
        const tracker = new TerminalResizeBurstTracker({ emit, now: Date.now });

        tracker.sample({ cols: 120, rows: 40 }, { localApplied: true, requestSent: true });
        vi.advanceTimersByTime(250);
        expect(emit).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sampleCount: 1,
                changeCount: 0,
                startCols: 120,
                finalCols: 120,
            }),
        );

        tracker.sample({ cols: 130, rows: 40 }, { localApplied: true, requestSent: true });
        vi.advanceTimersByTime(250);

        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sampleCount: 1,
                changeCount: 1,
                startCols: 120,
                startRows: 40,
                finalCols: 130,
                finalRows: 40,
            }),
        );
    });

    it('reports no change when a seeded burst only re-samples the existing grid', () => {
        vi.useFakeTimers();
        const emit = vi.fn();
        const tracker = new TerminalResizeBurstTracker({ emit, now: Date.now });

        tracker.sample({ cols: 120, rows: 40 }, { localApplied: true, requestSent: true });
        vi.advanceTimersByTime(250);
        expect(emit).toHaveBeenCalledOnce();

        tracker.sample({ cols: 120, rows: 40 }, { localApplied: false, requestSent: true });
        vi.advanceTimersByTime(250);

        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sampleCount: 1,
                changeCount: 0,
                startCols: 120,
                startRows: 40,
                finalCols: 120,
                finalRows: 40,
            }),
        );
    });

    it('keeps the final grid while marking a saturated sample count as truncated', () => {
        vi.useFakeTimers();
        const emit = vi.fn();
        const tracker = new TerminalResizeBurstTracker({ emit, maxSamples: 3, now: Date.now });

        tracker.sample({ cols: 153, rows: 59 }, { localApplied: false, requestSent: false });
        tracker.sample({ cols: 4, rows: 59 }, { localApplied: true, requestSent: true });
        tracker.sample({ cols: 4, rows: 59 }, { localApplied: false, requestSent: false });
        tracker.sample({ cols: 80, rows: 59 }, { localApplied: true, requestSent: true });
        vi.advanceTimersByTime(250);

        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({
                sampleCount: 3,
                changeCount: 2,
                finalCols: 80,
                localAppliedCount: 2,
                requestCount: 2,
                truncated: true,
            }),
        );
    });
});
