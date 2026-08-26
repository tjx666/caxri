import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeEvent, TerminalSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { TerminalManager } from '..';

const temporaryDirectories: string[] = [];

function createFakePty() {
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const process = {
        cols: 100,
        rows: 30,
        kill: vi.fn(),
        onData: vi.fn((listener: (data: string) => void) => {
            onData = listener;
            return { dispose: vi.fn() };
        }),
        onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
            onExit = listener;
            return { dispose: vi.fn() };
        }),
        resize: vi.fn(),
        write: vi.fn(),
    } as unknown as IPty;
    return {
        emitData: (data: string) => onData?.(data),
        emitExit: (event: { exitCode: number; signal?: number }) => onExit?.(event),
        process,
    };
}

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        pendingCleanup.map(async (path) => {
            try {
                await rm(path, { recursive: true, force: true });
            } catch {
                // Best-effort cleanup for logger writes that finish just after the assertion.
            }
        }),
    );
});

describe('TerminalManager snapshot persistence', () => {
    it('persists parsed screen state before reporting a stopped Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-screen-snapshot-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        let snapshotAtExit: TerminalSnapshot | undefined;
        const manager = new TerminalManager(
            database,
            (event: RuntimeEvent) => {
                if (event.event === 'terminal.exit')
                    snapshotAtExit = database.getSnapshot(created.terminal!.id);
            },
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        try {
            await manager.start(created.terminal!);
            const clipboardPayload = Buffer.from('HISTORICAL_CLIPBOARD').toString('base64');
            fake.emitData(`before\u{1B}]52;c;${clipboardPayload}\u{7}after`);
            fake.emitExit({ exitCode: 0 });

            await vi.waitFor(() => expect(snapshotAtExit).toBeDefined());
            expect(snapshotAtExit).toMatchObject({ cols: 100, encodingVersion: 3, rows: 30 });
            expect(snapshotAtExit?.payload).toContain('beforeafter');
            expect(snapshotAtExit?.payload).not.toContain(']52;');
            expect(snapshotAtExit?.payload).not.toContain(clipboardPayload);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it.each([1, 2, 99])('fails closed for snapshot encoding %i', async (encodingVersion) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-legacy-snapshot-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        database.saveSnapshot({
            byteCount: 14,
            cols: 100,
            encodingVersion,
            lineCount: 1,
            payload: 'LEGACY_HISTORY',
            rows: 30,
            terminalId: created.terminal!.id,
            updatedAt: Date.now(),
        });
        const fake = createFakePty();
        const manager = new TerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh'), spawn: () => fake.process },
        );

        try {
            await expect(manager.attach(created.terminal!.id)).resolves.toBeNull();
            await manager.start(created.terminal!);
            expect((await manager.attach(created.terminal!.id))?.payload).not.toContain(
                'LEGACY_HISTORY',
            );
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('fails closed for a current snapshot with invalid persisted grid metadata', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-invalid-grid-snapshot-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        database.saveSnapshot({
            byteCount: 7,
            cols: 100,
            encodingVersion: 3,
            lineCount: 1,
            payload: 'HISTORY',
            rows: 30,
            terminalId: created.terminal!.id,
            updatedAt: Date.now(),
        });
        database.database
            .prepare('UPDATE terminal_snapshots SET cols = 0 WHERE terminal_id = ?')
            .run(created.terminal!.id);
        const manager = new TerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { resolveExecutable: () => Promise.resolve('/bin/zsh') },
        );

        try {
            await expect(manager.attach(created.terminal!.id)).resolves.toBeNull();
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('finalizes the parsed screen before restarting the same durable Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-restart-snapshot-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const first = createFakePty();
        const spawned = [first, createFakePty()];
        const manager = new TerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => spawned.shift()!.process,
            },
        );

        try {
            await manager.start(created.terminal!);
            first.emitData('BEFORE_RESTART');
            await manager.restart(created.terminal!.id);

            expect(database.getSnapshot(created.terminal!.id)).toMatchObject({
                cols: 100,
                encodingVersion: 3,
                rows: 30,
            });
            expect((await manager.snapshot(created.terminal!.id))?.payload).toContain(
                'BEFORE_RESTART',
            );
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('awaits parsed screen persistence during orderly shutdown', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shutdown-snapshot-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const fake = createFakePty();
        let snapshotAtStateChange: TerminalSnapshot | undefined;
        const manager = new TerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                onStateChanged: (terminalId, state) => {
                    if (state === 'interrupted')
                        snapshotAtStateChange = database.getSnapshot(terminalId);
                },
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => fake.process,
            },
        );

        await manager.start(created.terminal!);
        fake.emitData('BEFORE_SHUTDOWN');
        await manager.shutdown('orderly');

        const snapshot = database.getSnapshot(created.terminal!.id);
        expect(snapshot).toMatchObject({ cols: 100, encodingVersion: 3, rows: 30 });
        expect(snapshot?.payload).toContain('BEFORE_SHUTDOWN');
        expect(snapshotAtStateChange).toMatchObject({
            cols: 100,
            encodingVersion: 3,
            rows: 30,
        });
        database.close();
    });
});
