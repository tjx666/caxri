import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { CaxriDatabase } from '../db/repository';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Agent Terminal restart', () => {
    it.each([
        {
            provider: 'claude' as const,
            resumeArguments: ['--resume', 'claude-session-1'],
            sessionId: 'claude-session-1',
        },
        {
            provider: 'codex' as const,
            resumeArguments: ['resume', 'codex-session-1'],
            sessionId: 'codex-session-1',
        },
    ])(
        'resumes a bound $provider session by default',
        async ({ provider, resumeArguments, sessionId }) => {
            const directory = await mkdtemp(join(tmpdir(), `caxri-runtime-${provider}-restart-`));
            temporaryDirectories.push(directory);
            const userDataPath = join(directory, 'user-data');
            const projectRoot = join(directory, 'project');
            await mkdir(projectRoot);
            const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
            const runtime = await createTestDomainServices({
                userDataPath,
                logger: new StructuredLogger(join(directory, 'logs')),
                send: () => {},
                terminal: {
                    resolveExecutable: () => Promise.resolve(`/usr/local/bin/${provider}`),
                    spawn,
                },
                agentAdapters: createPendingAgentAdapters(),
            });

            try {
                const project = await runtime.handlers['project.create']({
                    rootPath: projectRoot,
                });
                const created = await runtime.handlers['session.create']({
                    projectId: project.id,
                    defaultAgent: provider,
                });
                const createdActivityAt = created.session.lastSessionActivityAt;
                const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
                direct.database
                    .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
                    .run(sessionId, created.terminal!.id);
                direct.close();

                await runtime.handlers['terminal.restart']({
                    terminalId: created.terminal!.id,
                    mode: 'resume',
                });

                expect(spawn.mock.calls[1]?.[1]).toEqual(resumeArguments);
                const bootstrap = await runtime.handlers['app.bootstrap']({});
                const restartedSession = bootstrap.sessions.find(
                    (session) => session.id === created.session.id,
                )!;
                expect(restartedSession.lastSessionActivityAt).toBeGreaterThan(createdActivityAt);
                expect(restartedSession.lastSessionActivityReason).toBe('agent_started');
                expect(
                    bootstrap.terminals.find((terminal) => terminal.id === created.terminal!.id)
                        ?.agentSessionId,
                ).toBe(sessionId);
            } finally {
                await runtime.close();
            }
        },
    );

    it('starts fresh only when restart explicitly requests it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-fresh-restart-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                resolveExecutable: () => Promise.resolve('/usr/local/bin/codex'),
                spawn,
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
            direct.database
                .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
                .run('codex-session-old', created.terminal!.id);
            direct.close();

            await runtime.handlers['terminal.restart']({
                terminalId: created.terminal!.id,
                mode: 'fresh',
            });

            expect(spawn.mock.calls[1]?.[1]).toEqual([]);
            const bootstrap = await runtime.handlers['app.bootstrap']({});
            expect(
                bootstrap.terminals.find((terminal) => terminal.id === created.terminal!.id)
                    ?.agentSessionId,
            ).toBeUndefined();
        } finally {
            await runtime.close();
        }
    });
});
