import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { SessionAutoNamingService } from '../session/auto-naming';
import { SessionRenameService } from '../session/rename';
import { createFakePty } from './create-test-domain-services';

afterEach(() => vi.restoreAllMocks());

describe('Session deletion runtime retirement', () => {
    it.each(['session.delete', 'session.deleteMany', 'project.delete'] as const)(
        '%s retires rename state without deleting Project files',
        async (method) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-retirement-'));
            const projectRoot = join(directory, 'project');
            await mkdir(projectRoot);
            const userFile = join(projectRoot, 'fixture.txt');
            await writeFile(userFile, 'Synthetic user file\n');
            const rename = vi.spyOn(SessionRenameService.prototype, 'rename');
            const forgetNaming = vi.spyOn(SessionAutoNamingService.prototype, 'forgetSession');
            const runtime = await createTestDomainServices({
                userDataPath: join(directory, 'user-data'),
                logger: new StructuredLogger(join(directory, 'logs')),
                send: () => {},
                terminal: {
                    resolveExecutable: () => Promise.resolve('/bin/zsh'),
                    spawn: () => createFakePty(),
                },
            });
            try {
                const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
                const { session } = await runtime.handlers['session.create']({
                    projectId: project.id,
                    defaultAgent: 'shell',
                });
                await runtime.handlers['session.rename']({
                    sessionId: session.id,
                    displayTitle: 'Retirement fixture',
                });
                expect(rename).toHaveBeenCalledOnce();
                const renames = rename.mock.contexts[0] as SessionRenameService;
                expect(renames.revision(session.id)).toBe(1);

                const remaining =
                    method === 'project.delete'
                        ? await runtime.handlers[method]({ projectId: project.id })
                        : method === 'session.deleteMany'
                          ? await runtime.handlers[method]({ sessionIds: [session.id, session.id] })
                          : await runtime.handlers[method]({ sessionId: session.id });

                if (!('sessions' in remaining)) throw new Error('Deletion was cancelled');
                expect(remaining.sessions.some(({ id }) => id === session.id)).toBe(false);
                expect(renames.revision(session.id)).toBe(0);
                expect(forgetNaming).toHaveBeenCalledExactlyOnceWith(session.id);
                expect((await stat(userFile)).isFile()).toBe(true);
            } finally {
                await runtime.close();
                await rm(directory, { recursive: true, force: true });
            }
        },
    );
});
