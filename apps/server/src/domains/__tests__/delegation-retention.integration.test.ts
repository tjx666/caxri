import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { removeTestDirectory } from '../../__tests__/support/remove-test-directory';
import { CaxriDatabase } from '../db';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

describe('Delegation task retention', () => {
    it.each(['session', 'project'] as const)(
        'reclaims only owned task files when deleting a %s',
        async (target) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-retention-'));
            onTestFinished(() => removeTestDirectory(directory));
            const profile = join(directory, 'profile');
            const root = join(directory, 'project');
            await mkdir(profile);
            await mkdir(root);
            const sentinel = join(root, 'keep.txt');
            await writeFile(sentinel, 'Synthetic user file');
            const database = new CaxriDatabase(join(profile, 'caxri.db'));
            const project = database.createProject(root);
            const session = database.createSession(project.id, 'shell').session;
            const otherProject = database.createProject(directory);
            const other = database.createSession(otherProject.id, 'shell').session;
            const paths: string[] = [];
            await Promise.all(
                [session, other].map(async (ownedSession, index) => {
                    const id = randomUUID();
                    const taskDirectory = join(profile, 'delegations', id);
                    await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
                    await writeFile(join(taskDirectory, 'task.md'), 'Synthetic task', {
                        mode: 0o600,
                    });
                    paths[index] = taskDirectory;
                    database.agentDelegations.insert({
                        receipt: {
                            delegationId: id,
                            projectId: ownedSession.projectId,
                            sessionId: ownedSession.id,
                            provider: 'claude',
                            status: 'interrupted',
                            revision: 1,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        principal: { kind: 'human-cli', id: 'synthetic-owner' },
                        input: {
                            projectId: ownedSession.projectId,
                            sessionId: ownedSession.id,
                            provider: 'claude',
                            prompt: 'Synthetic task',
                        },
                        fingerprint: id,
                        promptDigest: 'a'.repeat(64),
                        frozenLaunch: { executable: 'claude', args: [] },
                    });
                }),
            );
            database.close();
            const runtime = await createTestDomainServices({
                userDataPath: profile,
                logger: new StructuredLogger(join(directory, 'logs')),
                send: () => {},
                terminal: { spawn: () => createFakePty() },
                agentAdapters: createPendingAgentAdapters(),
            });
            try {
                if (target === 'session')
                    await runtime.handlers['session.delete']({ sessionId: session.id });
                else await runtime.handlers['project.delete']({ projectId: project.id });
                await expect(access(paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
                expect(await readFile(join(paths[1], 'task.md'), 'utf8')).toBe('Synthetic task');
                expect(await readFile(sentinel, 'utf8')).toBe('Synthetic user file');
            } finally {
                await runtime.close();
            }
        },
    );
});
