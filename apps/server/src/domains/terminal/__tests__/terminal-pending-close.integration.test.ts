import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { IPty } from 'node-pty';
import { expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db/repository';

it('does not spawn a PTY whose durable record was closed while preparation was pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-pending-close-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const created = database.createSession(database.createProject(directory).id, 'shell');
    const executable = Promise.withResolvers<string>();
    const kill = vi.fn();
    const spawn = vi.fn(() => ({ kill }) as unknown as IPty);
    const logger = new StructuredLogger(join(directory, 'logs'));
    const manager = createTestTerminalManager(database, () => {}, logger, {
        resolveExecutable: () => executable.promise,
        spawn,
    });

    const starting = manager.start(created.terminal!);
    manager.close(created.terminal!.id);
    executable.resolve('/bin/zsh');
    try {
        await expect(starting).rejects.toBeInstanceOf(Error);
        expect(manager.runningCount()).toBe(0);
        expect(spawn).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
    } finally {
        manager.close(created.terminal!.id);
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Restore passes `shouldStart` as its navigation fence. A fence that turns stale during preparation must leave the
 * Terminal restorable exactly like one that turned stale before it; recording `failed` meant the next selection never
 * relaunched it and the tab showed a launch failure nobody caused.
 */
it('leaves a launch superseded during preparation interrupted instead of failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-superseded-launch-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const created = database.createSession(database.createProject(directory).id, 'shell');
    const spawn = vi.fn(() => ({ kill: vi.fn() }) as unknown as IPty);
    const logger = new StructuredLogger(join(directory, 'logs'));
    const manager = createTestTerminalManager(database, () => {}, logger, {
        resolveExecutable: () => Promise.resolve('/bin/zsh'),
        spawn,
    });
    let fenceChecks = 0;

    try {
        // Current at the check before preparation, superseded from the one after it on.
        await expect(
            manager.start(created.terminal!, { shouldStart: () => ++fenceChecks === 1 }),
        ).resolves.toMatchObject({ lastProcessState: 'interrupted' });
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            lastProcessState: 'interrupted',
            failureReason: undefined,
        });
        expect(spawn).not.toHaveBeenCalled();
        expect(manager.runningCount()).toBe(0);
    } finally {
        manager.close(created.terminal!.id);
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});
