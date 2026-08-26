import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { TerminalManager } from '..';

const temporaryDirectories: string[] = [];

function createFakePty(): IPty {
    return {
        kill: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        write: vi.fn(),
    } as unknown as IPty;
}

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('TerminalManager shell integration launch', () => {
    it('applies controlled argv and environment to a shell launch', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-shell-integration-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const shellIntegration = vi.fn((executable: string, environment: NodeJS.ProcessEnv) => ({
            args: ['--controlled'],
            environment: { ...environment, CAXRI_INTEGRATED: executable },
        }));
        const manager = new TerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                shellIntegration,
                spawn,
            },
        );

        try {
            await manager.start(created.terminal!);
            expect(shellIntegration).toHaveBeenCalledWith('/bin/zsh', expect.any(Object));
            // `.at(0)` (not `[0]`) keeps the result typed as possibly missing: `spawn` may never have
            // been called if the assertion above already failed.
            const options = spawn.mock.calls.at(0)?.[2];
            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/zsh');
            expect(spawn.mock.calls[0]?.[1]).toEqual(['--controlled']);
            expect(options?.env).toMatchObject({ CAXRI_INTEGRATED: '/bin/zsh' });
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });

    it('falls back to the ordinary login shell when integration resolution fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-shell-fallback-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const manager = new TerminalManager(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                resolveExecutable: () => Promise.resolve('/bin/fish'),
                shellIntegration: () => {
                    throw new Error('integration unavailable');
                },
                spawn,
            },
        );

        try {
            await expect(manager.start(created.terminal!)).resolves.toBeDefined();
            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/fish');
            expect(spawn.mock.calls[0]?.[1]).toEqual(['-l']);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
        }
    });
});
