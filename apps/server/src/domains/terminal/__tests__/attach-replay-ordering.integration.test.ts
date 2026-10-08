import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db/repository';

const temporaryDirectories: string[] = [];
const temporaryLoggers: StructuredLogger[] = [];

function createTestLogger(logDirectory: string): StructuredLogger {
    const logger = new StructuredLogger(logDirectory);
    temporaryLoggers.push(logger);
    return logger;
}

function createFakePty(): { emitData: (data: string) => void; process: IPty } {
    let onData: ((data: string) => void) | undefined;
    const process = {
        cols: 100,
        kill: vi.fn(),
        pid: 7_778,
        onData: vi.fn((listener: (data: string) => void) => {
            onData = listener;
            return { dispose: vi.fn() };
        }),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        rows: 30,
        write: vi.fn(),
    } as unknown as IPty;
    return { emitData: (data: string) => onData?.(data), process };
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
 * Companion to `terminal.integration.test.ts`'s "does not replay queued live output after returning it in an attachment
 * snapshot", which re-attaches while the batch is still queued. Here the 16 ms flush timer runs first, so the batch has
 * already left as live output before the re-attach starts: the other half of issue #740's ordering.
 *
 * This characterizes the Terminal Host engine, which `createTestTerminalManager` reaches through the in-process
 * `LocalTerminalExecution` adapter. It is deliberately not the guard for #740's Server Core fix: that window only
 * exists in `RemoteTerminalExecution` and is owned by `core/terminal-host/__tests__/execution.test.ts`.
 */
describe('TerminalManager attach replay ordering', () => {
    it('ships an already flushed batch once when a re-attach follows the flush timer', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-attach-flushed-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        const emitted: string[] = [];
        const manager = createTestTerminalManager(
            database,
            (event) => {
                if (event.event === 'terminal.output') emitted.push(event.payload.data);
            },
            createTestLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        await manager.start(created.terminal!);
        await manager.attach(created.terminal!.id);
        fake.emitData('flushed exactly once');
        await new Promise((resolve) => setTimeout(resolve, 30));

        try {
            expect(emitted.join('')).toContain('flushed exactly once');
            const snapshotPayload = (await manager.attach(created.terminal!.id))?.payload;
            /**
             * One copy in each place is the correct outcome for this ordering, not a duplicate: the Renderer installs
             * its replacement replay buffer only when it starts the re-attach, so a batch emitted before that went to
             * the buffer this snapshot replaces. What must not happen is the re-attach shipping it as live output a
             * second time, which would land it _after_ the snapshot and render it twice.
             */
            expect(snapshotPayload).toContain('flushed exactly once');
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(emitted.join('').split('flushed exactly once')).toHaveLength(2);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });
});
