import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { CaxriDatabase } from '../db/repository';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Fallback Session restoration', () => {
    it.each(['session.archive', 'session.delete', 'project.delete'] as const)(
        'restores the interrupted fallback after %s without another selection',
        async (method) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-fallback-restore-'));
            temporaryDirectories.push(directory);
            const userDataPath = join(directory, 'user-data');
            const projectRoot = join(directory, 'project');
            await mkdir(projectRoot);
            const database = new CaxriDatabase(join(userDataPath, 'caxri.db'));
            const project = database.createProject(await realpath(projectRoot));
            const fallback = database.createSession(project.id, 'shell');
            database.updateTerminalState(fallback.terminal!.id, 'interrupted');
            const selectedProjectRoot = join(directory, 'selected-project');
            await mkdir(selectedProjectRoot);
            const selectedProject =
                method === 'project.delete'
                    ? database.createProject(await realpath(selectedProjectRoot))
                    : project;
            const selected = database.createSession(selectedProject.id, null);
            database.selectSession(selected.session.id, 'main');
            database.close();

            const runtime = await createTestDomainServices({
                userDataPath,
                terminalRestoreGridWaitMs: 0,
                logger: new StructuredLogger(join(directory, 'logs')),
                send: () => {},
                terminal: {
                    resolveExecutable: () => Promise.resolve('/bin/zsh'),
                    spawn: () => createFakePty(),
                },
            });
            try {
                if (method === 'project.delete')
                    await runtime.handlers[method]({ projectId: selectedProject.id });
                else await runtime.handlers[method]({ sessionId: selected.session.id });
                await vi.waitFor(async () => {
                    const state = await runtime.handlers['app.bootstrap']({});
                    expect(
                        state.terminals.find((terminal) => terminal.id === fallback.terminal!.id)
                            ?.lastProcessState,
                    ).toBe('running');
                });
            } finally {
                await runtime.close();
            }
        },
    );
});
