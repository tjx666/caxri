import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db/repository';

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
    it('persists the managed Agent shell-integration failure detail', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-agent-shell-integration-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const manager = createTestTerminalManager(database, () => {}, logger, {
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/codex'),
            shellIntegration: () => {},
        });

        try {
            await expect(manager.start(created.terminal!)).rejects.toThrow(
                'Managed Agent Terminals require zsh or bash shell integration',
            );
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                lastProcessState: 'failed',
                failureReason: 'spawn_failed',
                failureDetail: 'Managed Agent Terminals require zsh or bash shell integration.',
            });
        } finally {
            manager.close(created.terminal!.id);
            database.close();
            await logger.flush();
        }
    });

    it.each([
        { exhausted: true, failureReason: 'pty_exhausted' },
        { exhausted: false, failureReason: 'spawn_failed' },
    ])(
        'records a PTY allocation failure as $failureReason when the machine exhausted is $exhausted',
        async ({ exhausted, failureReason }) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-exhausted-'));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'shell');
            const logger = new StructuredLogger(join(directory, 'logs'));
            const manager = createTestTerminalManager(database, () => {}, logger, {
                isPtyExhausted: () => Promise.resolve(exhausted),
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: vi.fn<typeof spawnPty>(() => {
                    throw new Error('forkpty(3) failed.');
                }),
            });

            try {
                await expect(manager.start(created.terminal!)).rejects.toThrow(
                    'forkpty(3) failed.',
                );
                expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                    lastProcessState: 'failed',
                    failureReason,
                });
            } finally {
                manager.close(created.terminal!.id);
                database.close();
                await logger.flush();
            }
        },
    );

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
        const logger = new StructuredLogger(join(directory, 'logs'));
        const manager = createTestTerminalManager(database, () => {}, logger, {
            resolveExecutable: () => Promise.resolve('/bin/zsh'),
            shellIntegration,
            spawn,
        });

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
            await logger.flush();
        }
    });

    it('falls back to the ordinary login shell when integration resolution fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-shell-fallback-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const logger = new StructuredLogger(join(directory, 'logs'));
        const manager = createTestTerminalManager(database, () => {}, logger, {
            resolveExecutable: () => Promise.resolve('/bin/fish'),
            shellIntegration: () => {
                throw new Error('integration unavailable');
            },
            spawn,
        });

        try {
            await expect(manager.start(created.terminal!)).resolves.toBeDefined();
            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/fish');
            expect(spawn.mock.calls[0]?.[1]).toEqual(['-l']);
        } finally {
            manager.close(created.terminal!.id);
            database.close();
            await logger.flush();
        }
    });
});
