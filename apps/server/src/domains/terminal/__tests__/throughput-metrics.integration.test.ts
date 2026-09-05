import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db/repository';

const temporaryDirectories: string[] = [];
const temporaryLoggers: StructuredLogger[] = [];

/**
 * Tracks buffered loggers so teardown flushes async appends before removing each temporary profile.
 */
function createTestLogger(logDirectory: string): StructuredLogger {
    const logger = new StructuredLogger(logDirectory);
    temporaryLoggers.push(logger);
    return logger;
}

function createFakePty() {
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    let cols = 100;
    let rows = 30;
    const kill = vi.fn();
    const resize = vi.fn((nextCols: number, nextRows: number) => {
        cols = nextCols;
        rows = nextRows;
    });
    const write = vi.fn();
    const process = {
        get cols() {
            return cols;
        },
        kill,
        pid: 8_888,
        onData: vi.fn((listener: (data: string) => void) => {
            onData = listener;
            return { dispose: vi.fn() };
        }),
        onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
            onExit = listener;
            return { dispose: vi.fn() };
        }),
        resize,
        get rows() {
            return rows;
        },
        write,
    } as unknown as IPty;
    return {
        emitData: (data: string) => onData?.(data),
        emitExit: (event: { exitCode: number; signal?: number }) => onExit?.(event),
        kill,
        process,
        resize,
        write,
    };
}

afterEach(async () => {
    const pendingLoggers = [...temporaryLoggers];
    temporaryLoggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Owning-layer regression for #590 / #605: steady-state PTY traffic must not add `info` records per aggregation window,
 * while first input, dropped bytes, and retirement still leave durable evidence.
 */
describe('PTY throughput metrics', () => {
    it('writes info only for first input, dropped bytes, and the lifetime summary', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-throughput-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const terminalId = created.terminal!.id;
        const fake = createFakePty();
        const logger = createTestLogger(join(directory, 'logs'));
        const write = vi.spyOn(logger, 'write');
        const recordMetric = vi.spyOn(logger, 'recordMetric');
        const spawn = vi.fn<typeof spawnPty>(() => fake.process);
        const manager = createTestTerminalManager(database, () => {}, logger, {
            resolveExecutable: () => Promise.resolve('/bin/zsh'),
            spawn,
        });
        const writesFor = (event: string) => write.mock.calls.filter((call) => call[1] === event);
        const infoWritesFor = (event: string) =>
            writesFor(event).filter((call) => call[0] === 'info');

        try {
            await manager.start(created.terminal!);

            // Three consecutive active windows: the info volume must not grow with the window count.
            for (let window = 0; window < 3; window += 1) {
                expect(manager.write(terminalId, 'echo hi\r')).toBe(true);
                fake.emitData('hi\r\n');
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, 1_050));
            }
            expect(
                recordMetric.mock.calls.filter((call) => call[0] === 'pty.throughput'),
            ).toHaveLength(3);
            expect(writesFor('pty.throughput')).toHaveLength(3);
            expect(infoWritesFor('pty.throughput')).toHaveLength(0);
            expect(infoWritesFor('pty.first_input')).toHaveLength(1);
            const firstInput = infoWritesFor('pty.first_input')[0]?.[2];
            expect(firstInput?.durationMs).toBeTypeOf('number');
            expect(firstInput?.fields).toEqual({ terminalId, inputBytes: 8 });

            // Attach a view and push output past its 256KB queue in a single chunk to force a real drop.
            await manager.attach(terminalId);
            fake.emitData('x'.repeat(300 * 1024));
            await new Promise((resolve) => setTimeout(resolve, 1_050));

            const warnWrites = writesFor('pty.throughput').filter((call) => call[0] === 'warn');
            expect(warnWrites).toHaveLength(1);
            expect(warnWrites[0]?.[2]?.fields).toMatchObject({ terminalId });
            const droppedBytes = (warnWrites[0]?.[2]?.fields as { droppedBytes: number })
                .droppedBytes;
            expect(droppedBytes).toBeGreaterThan(0);
            expect(infoWritesFor('pty.throughput_summary')).toHaveLength(0);

            manager.close(terminalId);

            const summaries = infoWritesFor('pty.throughput_summary');
            expect(summaries).toHaveLength(1);
            const summary = summaries[0]?.[2];
            expect(summary?.durationMs).toBeTypeOf('number');
            expect(summary?.fields).toEqual({
                terminalId,
                reason: 'discarded',
                inputBytes: 24,
                outputBytes: 3 * 4 + 300 * 1024,
                droppedBytes,
                peakWindowBytes: 300 * 1024,
                windows: 4,
            });
            const summaryFields = summary?.fields ?? {};
            expect(JSON.stringify(summaryFields)).not.toContain('echo');
            expect(JSON.stringify(summaryFields)).not.toContain(directory);
        } finally {
            manager.close(terminalId);
            database.close();
        }
    }, 15_000);
});
