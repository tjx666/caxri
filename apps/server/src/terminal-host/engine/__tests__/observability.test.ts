import type { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createPtyThroughputTally,
    PtyResizeBurstObserver,
    recordPtyDroppedBytes,
    recordPtyThroughput,
    recordPtyThroughputSummary,
    recordPtyThroughputWindow,
} from '../observability';

function resizeLogger() {
    const write = vi.fn<StructuredLogger['write']>();
    return { logger: { write } as unknown as StructuredLogger, write };
}

describe('PTY observability', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('records bounded byte aggregates without Terminal content or identity', () => {
        const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
        const logger = { recordMetric } as unknown as StructuredLogger;

        recordPtyThroughput(logger, { droppedBytes: 7, inputBytes: 3, outputBytes: 5 });
        recordPtyDroppedBytes(logger, 0);

        expect(recordMetric).toHaveBeenNthCalledWith(1, 'pty.throughput', 8, {
            owner: 'terminal-host',
            phase: 'transfer',
            outcome: 'success',
        });
        expect(recordMetric).toHaveBeenNthCalledWith(2, 'pty.dropped_bytes', 7, {
            owner: 'terminal-host',
            phase: 'transfer',
            outcome: 'overflow',
        });
        expect(recordMetric).toHaveBeenCalledTimes(2);
    });

    it('keeps steady-state windows in the metrics layer and writes info only for first input', () => {
        const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
        const write = vi.fn<StructuredLogger['write']>();
        const logger = { recordMetric, write } as unknown as StructuredLogger;
        const tally = createPtyThroughputTally(1_000);

        recordPtyThroughputWindow(
            logger,
            'terminal-1',
            tally,
            { droppedBytes: 0, inputBytes: 0, outputBytes: 40 },
            2_000,
        );
        // The engine stamps the first input write itself; the window carrying it closes later, at 3_500.
        tally.firstInputAt = 2_700;
        recordPtyThroughputWindow(
            logger,
            'terminal-1',
            tally,
            { droppedBytes: 0, inputBytes: 8, outputBytes: 100 },
            3_500,
        );
        recordPtyThroughputWindow(
            logger,
            'terminal-1',
            tally,
            { droppedBytes: 0, inputBytes: 8, outputBytes: 20 },
            4_500,
        );

        expect(recordMetric.mock.calls.filter((call) => call[0] === 'pty.throughput')).toHaveLength(
            3,
        );
        const infoWrites = write.mock.calls.filter((call) => call[0] === 'info');
        expect(infoWrites).toEqual([
            [
                'info',
                'pty.first_input',
                { durationMs: 1_700, fields: { terminalId: 'terminal-1', inputBytes: 8 } },
            ],
        ]);
        expect(write.mock.calls.filter((call) => call[1] === 'pty.throughput')).toHaveLength(0);
        expect(tally).toMatchObject({
            droppedBytes: 0,
            firstInputLogged: true,
            inputBytes: 16,
            outputBytes: 160,
            peakWindowBytes: 108,
            windows: 3,
        });
    });

    it('keeps dropped bytes at warn and restores lifetime totals in the retirement summary', () => {
        const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
        const write = vi.fn<StructuredLogger['write']>();
        const logger = { recordMetric, write } as unknown as StructuredLogger;
        const tally = createPtyThroughputTally(1_000);

        recordPtyThroughputWindow(
            logger,
            'terminal-1',
            tally,
            { droppedBytes: 5, inputBytes: 0, outputBytes: 300 },
            2_000,
        );
        recordPtyThroughputSummary(logger, 'terminal-1', tally, 'exited', 9_000);

        expect(write).toHaveBeenNthCalledWith(1, 'warn', 'pty.throughput', {
            fields: {
                terminalId: 'terminal-1',
                inputBytes: 0,
                outputBytes: 300,
                droppedBytes: 5,
                droppedWindows: 1,
            },
        });
        expect(write).toHaveBeenNthCalledWith(2, 'info', 'pty.throughput_summary', {
            durationMs: 8_000,
            fields: {
                terminalId: 'terminal-1',
                reason: 'exited',
                inputBytes: 0,
                outputBytes: 300,
                droppedBytes: 5,
                droppedWindows: 1,
                peakWindowBytes: 300,
                windows: 1,
            },
        });
        expect(write).toHaveBeenCalledTimes(2);
        expect(recordMetric).toHaveBeenCalledWith('pty.dropped_bytes', 5, {
            owner: 'terminal-host',
            phase: 'transfer',
            outcome: 'overflow',
        });
    });

    it('folds repeated drops into one warn record per interval', () => {
        const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
        const write = vi.fn<StructuredLogger['write']>();
        const logger = { recordMetric, write } as unknown as StructuredLogger;
        const tally = createPtyThroughputTally(0);
        const drop = (droppedBytes: number, now: number) =>
            recordPtyThroughputWindow(
                logger,
                'terminal-1',
                tally,
                { droppedBytes, inputBytes: 0, outputBytes: 10 },
                now,
            );

        drop(4, 1_000);
        for (let second = 2; second < 61; second += 1) drop(1, second * 1_000);
        drop(3, 61_000);
        recordPtyThroughputSummary(logger, 'terminal-1', tally, 'exited', 62_000);

        const drops = write.mock.calls.filter((call) => call[1] === 'pty.throughput');
        expect(
            drops.map((call) => [call[2]?.fields?.droppedBytes, call[2]?.fields?.droppedWindows]),
        ).toEqual([
            [4, 1],
            [62, 60],
        ]);
        expect(write.mock.lastCall?.[2]?.fields).toMatchObject({
            droppedBytes: 66,
            droppedWindows: 61,
        });
    });

    it('writes one bounded summary after 250ms of resize quiet', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);

        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        vi.advanceTimersByTime(40);
        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        vi.advanceTimersByTime(40);
        observer.recordApplied('terminal-1', { cols: 4, rows: 12 });
        vi.advanceTimersByTime(40);
        observer.recordApplied('terminal-1', { cols: 80, rows: 30 });

        vi.advanceTimersByTime(249);
        expect(write).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(write).toHaveBeenCalledOnce();
        expect(write).toHaveBeenCalledWith('info', 'pty.resize_burst', {
            fields: {
                code: 'PTY_RESIZE_BURST',
                terminalId: 'terminal-1',
                side: 'terminal-host-pty',
                sampleCount: 4,
                changeCount: 2,
                startCols: 120,
                startRows: 40,
                minCols: 4,
                minRows: 12,
                maxCols: 120,
                maxRows: 40,
                finalCols: 80,
                finalRows: 30,
                durationMs: 120,
                flushReason: 'quiet',
                truncated: false,
            },
        });
    });

    it('seeds a later burst from the previously applied grid so a one-step resize reads as a change', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);

        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        vi.advanceTimersByTime(250);
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[2]?.fields).toMatchObject({
            sampleCount: 1,
            changeCount: 0,
            startCols: 120,
            finalCols: 120,
        });

        observer.recordApplied('terminal-1', { cols: 130, rows: 40 });
        vi.advanceTimersByTime(250);

        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1]?.[2]?.fields).toMatchObject({
            sampleCount: 1,
            changeCount: 1,
            startCols: 120,
            startRows: 40,
            finalCols: 130,
            finalRows: 40,
        });
    });

    it('reports no change when a seeded burst only re-samples the existing grid', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);

        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        vi.advanceTimersByTime(250);
        expect(write).toHaveBeenCalledOnce();

        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        vi.advanceTimersByTime(250);

        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1]?.[2]?.fields).toMatchObject({
            sampleCount: 1,
            changeCount: 0,
            startCols: 120,
            startRows: 40,
            finalCols: 120,
            finalRows: 40,
        });
    });

    it('does not seed a burst for a Terminal id reused after disposeTerminal cleared its remembered grid', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);

        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        observer.disposeTerminal('terminal-1');
        expect(write).toHaveBeenCalledOnce();

        observer.recordApplied('terminal-1', { cols: 130, rows: 40 });
        vi.advanceTimersByTime(250);

        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1]?.[2]?.fields).toMatchObject({
            sampleCount: 1,
            changeCount: 0,
            startCols: 130,
            startRows: 40,
            finalCols: 130,
            finalRows: 40,
        });
    });

    it('bounds a continuously changing resize burst at five seconds', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);
        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });

        for (let index = 1; index <= 20; index += 1) {
            vi.advanceTimersByTime(240);
            observer.recordApplied('terminal-1', {
                cols: index % 2 === 0 ? 120 : 4,
                rows: index % 2 === 0 ? 40 : 12,
            });
        }
        vi.advanceTimersByTime(200);

        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[2]?.fields).toMatchObject({
            terminalId: 'terminal-1',
            durationMs: 4_800,
            flushReason: 'max-duration',
            truncated: false,
        });
    });

    it('flushes an unfinished burst once on dispose and clears its timers', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);
        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        vi.advanceTimersByTime(50);
        observer.recordApplied('terminal-1', { cols: 4, rows: 12 });

        observer.dispose();

        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[2]?.fields).toMatchObject({
            terminalId: 'terminal-1',
            finalCols: 4,
            finalRows: 12,
            durationMs: 50,
            flushReason: 'disposed',
            truncated: false,
        });

        vi.advanceTimersByTime(10_000);
        expect(write).toHaveBeenCalledOnce();
    });

    it('isolates Terminal bursts and retires one without a late timer', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);
        observer.recordApplied('terminal-1', { cols: 120, rows: 40 });
        observer.recordApplied('terminal-2', { cols: 80, rows: 30 });

        observer.disposeTerminal('terminal-1');
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[2]?.fields).toMatchObject({
            terminalId: 'terminal-1',
            flushReason: 'disposed',
        });

        vi.advanceTimersByTime(250);
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1]?.[2]?.fields).toMatchObject({
            terminalId: 'terminal-2',
            flushReason: 'quiet',
        });

        vi.advanceTimersByTime(5_000);
        expect(write).toHaveBeenCalledTimes(2);
    });

    it('saturates counts while retaining the final applied grid', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);

        for (let index = 0; index <= 10_000; index += 1)
            observer.recordApplied('terminal-1', {
                cols: index % 2 === 0 ? 120 : 80,
                rows: 30,
            });
        observer.dispose();

        expect(write.mock.calls[0]?.[2]?.fields).toMatchObject({
            terminalId: 'terminal-1',
            sampleCount: 10_000,
            changeCount: 9_999,
            finalCols: 120,
            finalRows: 30,
            truncated: true,
        });
    });

    it('keeps the PTY resize log field set content-free', () => {
        const { logger, write } = resizeLogger();
        const observer = new PtyResizeBurstObserver(logger);
        observer.recordApplied('opaque-terminal-id', { cols: 80, rows: 30 });
        observer.recordApplied('opaque-terminal-id', { cols: 4, rows: 12 });
        observer.dispose();

        const fields = write.mock.calls[0]?.[2]?.fields;
        expect(
            Object.keys(fields ?? {}).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(
            [
                'changeCount',
                'code',
                'durationMs',
                'finalCols',
                'finalRows',
                'flushReason',
                'maxCols',
                'maxRows',
                'minCols',
                'minRows',
                'sampleCount',
                'side',
                'startCols',
                'startRows',
                'terminalId',
                'truncated',
            ].toSorted((left, right) => left.localeCompare(right)),
        );
        expect(JSON.stringify(fields)).not.toMatch(
            /terminalOutput|snapshot|command|cwd|path|environment|private transcript/u,
        );
    });
});
