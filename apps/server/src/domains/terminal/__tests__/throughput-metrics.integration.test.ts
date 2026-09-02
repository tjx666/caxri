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

describe('PTY throughput metrics', () => {
    it('only writes a durable pty.throughput line when the output queue actually drops bytes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-throughput-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const logger = createTestLogger(join(directory, 'logs'));
        const write = vi.spyOn(logger, 'write');
        const spawn = vi.fn<typeof spawnPty>(() => fake.process);
        const manager = createTestTerminalManager(database, () => {}, logger, {
            resolveExecutable: () => Promise.resolve('/bin/zsh'),
            spawn,
        });
        const throughputLogs = () =>
            write.mock.calls.filter((call) => call[1] === 'pty.throughput');

        try {
            await manager.start(created.terminal!);
            /**
             * Plain input traffic with no attached view never overflows the output queue: the 1s metrics flush must
             * stay silent even though `recordPtyThroughput` still feeds the same counts into the metric registry
             * unconditionally (verified indirectly here since the byte counters are private to the engine).
             */
            expect(manager.write(created.terminal!.id, 'echo hi\r')).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 1_050));
            expect(throughputLogs()).toHaveLength(0);

            // Attach a view and push output past its 256KB queue in a single chunk to force a real drop.
            await manager.attach(created.terminal!.id);
            fake.emitData('x'.repeat(300 * 1024));
            await new Promise((resolve) => setTimeout(resolve, 1_050));

            const logs = throughputLogs();
            expect(logs).toHaveLength(1);
            expect(logs[0]?.[0]).toBe('warn');
            expect(logs[0]?.[2]?.fields).toMatchObject({ terminalId: created.terminal!.id });
            const droppedBytes = (logs[0]?.[2]?.fields as { droppedBytes: number }).droppedBytes;
            expect(droppedBytes).toBeGreaterThan(0);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    }, 15_000);
});
