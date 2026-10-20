import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import { LocalTerminalExecution } from '../../../__tests__/support/local-terminal-execution';
import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db/repository';
import { MAX_TERMINALS_GLOBAL, MAX_TERMINALS_PER_SESSION } from '../../db/terminal-capacity';

describe('PTY relaunch capacity', () => {
    it('refuses to relaunch a suspended Terminal while the live Terminals fill the limit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-pty-capacity-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const logger = new StructuredLogger(join(directory, 'logs'));
        const project = database.createProject(directory);
        const created = database.createSession(project.id, 'codex');
        const parked = created.terminal!;
        database.updateTerminalState(parked.id, 'suspended');
        database.updateAgentProcessState(parked.id, 'suspended');
        let sessionId = created.session.id;
        for (let index = 0; index < MAX_TERMINALS_GLOBAL; index += 1) {
            if (index > 0 && index % MAX_TERMINALS_PER_SESSION === 0)
                sessionId = database.createSession(project.id, null).session.id;
            database.createTerminal(sessionId, 'shell', directory);
        }
        const spawn = vi.fn<typeof spawnPty>();
        const manager = createTestTerminalManager(database, () => {}, logger, {
            execution: new LocalTerminalExecution({ logger, spawn }),
            resolveExecutable: () => Promise.resolve('/bin/zsh'),
        });
        try {
            await expect(manager.restart(parked.id)).rejects.toMatchObject({ code: 'CAPACITY' });
            expect(spawn).not.toHaveBeenCalled();
            expect(database.getTerminal(parked.id)?.lastProcessState).toBe('suspended');
        } finally {
            database.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
