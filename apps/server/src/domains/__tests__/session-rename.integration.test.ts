import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import { logEventCatalog, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionRenameService } from '../session/rename';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function flushLoggers(): Promise<void> {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
}
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await flushLoggers();
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Session rename', () => {
    it('does not create a manual revision for a missing Session and forgets an existing one', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-revision-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(projectRoot);
        const created = database.createSession(project.id, 'shell', projectRoot);
        const agents = new AgentService(undefined, createPendingAgentAdapters({}));
        const coordinator = new AgentCoordinator(
            database,
            agents,
            () => {},
            createLogger(join(directory, 'logs')),
        );
        const service = new SessionRenameService(
            database,
            agents,
            coordinator,
            () => {},
            createLogger(join(directory, 'rename-logs')),
        );

        try {
            await expect(service.rename('missing-session', 'Valid title')).rejects.toMatchObject({
                code: 'NOT_FOUND',
                message: 'Session not found',
            });
            expect(service.revision('missing-session')).toBe(0);

            await expect(
                service.rename(created.session.id, 'Existing title'),
            ).resolves.toMatchObject({
                displayTitle: 'Existing title',
                titleMode: 'manual',
            });
            expect(service.revision(created.session.id)).toBe(1);

            service.forgetSession(created.session.id);
            expect(service.revision(created.session.id)).toBe(0);
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('persists local-only Session names under manual ownership', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-session-rename-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: createLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            await expect(
                runtime.handlers['session.rename']({
                    sessionId: created.session.id,
                    displayTitle: '  Focused investigation  ',
                }),
            ).resolves.toMatchObject({
                displayTitle: 'Focused investigation',
                titleMode: 'manual',
            });
            await expect(
                runtime.handlers['session.rename']({
                    sessionId: created.session.id,
                    displayTitle: ' '.repeat(3),
                }),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(
                runtime.handlers['session.rename']({
                    sessionId: created.session.id,
                    displayTitle: 'First line\n/compact',
                }),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            const cancellation = new AbortController();
            cancellation.abort();
            await expect(
                runtime.handlers['session.rename'](
                    {
                        sessionId: created.session.id,
                        displayTitle: 'Must not persist',
                    },
                    cancellation.signal,
                ),
            ).rejects.toMatchObject({ code: 'CANCELLED' });
            const state = await runtime.handlers['app.bootstrap']({});
            expect(
                state.sessions.find((session) => session.id === created.session.id),
            ).toMatchObject({ displayTitle: 'Focused investigation', titleMode: 'manual' });
        } finally {
            await runtime.close();
        }
    });

    it('keeps the requested Session name when the provider chooses a different native title', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-session-rename-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const events: ServerEvent[] = [];
        const providerAcceptance = Promise.withResolvers<{ displayTitle: string }>();
        const renameSession = vi
            .fn()
            .mockImplementationOnce(() => providerAcceptance.promise)
            .mockRejectedValueOnce(new CaxriError('UNAVAILABLE', 'Claude rename failed'));
        const logger = createLogger(join(directory, 'logs'));
        const log = vi.spyOn(logger, 'write');
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger,
            send: (event) => events.push(event),
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
            agentAdapters: createPendingAgentAdapters({
                claude: {
                    provider: 'claude',
                    renameSession,
                    snapshot: () =>
                        Promise.resolve({
                            available: true,
                            observedAt: Date.now(),
                            provider: 'claude',
                            sessionId: 'agent-session-1',
                            status: 'unknown',
                        }),
                },
            }),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'claude',
            });

            const pendingRename = runtime.handlers['session.rename']({
                sessionId: created.session.id,
                displayTitle: 'Focused investigation',
            });
            await vi.waitFor(() => expect(renameSession).toHaveBeenCalledOnce());
            const pendingState = await runtime.handlers['app.bootstrap']({});
            expect(
                pendingState.sessions.find((session) => session.id === created.session.id),
            ).toMatchObject({ displayTitle: 'Untitled', titleMode: 'automatic' });

            providerAcceptance.resolve({
                displayTitle:
                    'Focused investigation-tingly-tide ("Focused investigation" is held by another live session on this machine)',
            });
            await expect(pendingRename).resolves.toMatchObject({
                displayTitle: 'Focused investigation',
                titleMode: 'manual',
            });
            expect(log).toHaveBeenCalledWith(
                'warn',
                logEventCatalog.sessionRename.providerTitleMismatch,
                expect.objectContaining({
                    fields: { provider: 'claude', sessionId: created.session.id },
                }),
            );
            expect(renameSession).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    agentSessionId: 'agent-session-1',
                    cwd: project.rootPath,
                    displayTitle: 'Focused investigation',
                }),
            );

            const recordsEventsBeforeFailure = events.filter(
                (event) =>
                    event.event === 'state.changed' &&
                    event.payload.kind === 'records' &&
                    event.payload.sessionIds.includes(created.session.id),
            ).length;
            await expect(
                runtime.handlers['session.rename']({
                    sessionId: created.session.id,
                    displayTitle: 'Must not persist',
                }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            const state = await runtime.handlers['app.bootstrap']({});
            expect(
                state.sessions.find((session) => session.id === created.session.id),
            ).toMatchObject({
                displayTitle: 'Focused investigation',
                titleMode: 'manual',
            });
            expect(
                events.filter(
                    (event) =>
                        event.event === 'state.changed' &&
                        event.payload.kind === 'records' &&
                        event.payload.sessionIds.includes(created.session.id),
                ),
            ).toHaveLength(recordsEventsBeforeFailure);
        } finally {
            await runtime.close();
        }
    });

    it('retries the current primary Agent binding when a resume lands during rename', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-rebind-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(
            database.createProject(projectRoot).id,
            'codex',
            projectRoot,
        );
        database.rebindAgentSession(created.terminal!.id, 'codex', 'agent-session-a');
        const firstProviderResult = Promise.withResolvers<{ displayTitle: string }>();
        const renameSession = vi.fn(({ agentSessionId }: { agentSessionId: string }) =>
            agentSessionId === 'agent-session-a'
                ? firstProviderResult.promise
                : Promise.resolve({ displayTitle: 'Applied to resumed Session' }),
        );
        const agents = new AgentService(
            undefined,
            createPendingAgentAdapters({
                codex: {
                    provider: 'codex',
                    renameSession,
                    snapshot: (context) =>
                        Promise.resolve({
                            available: true,
                            observedAt: Date.now(),
                            provider: 'codex',
                            sessionId: context.agentSessionId,
                            status: 'unknown',
                        }),
                },
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            agents,
            () => {},
            createLogger(join(directory, 'logs')),
        );
        const service = new SessionRenameService(
            database,
            agents,
            coordinator,
            () => {},
            createLogger(join(directory, 'rename-logs')),
        );

        try {
            const pendingRename = service.rename(created.session.id, 'Requested title');
            await vi.waitFor(() => expect(renameSession).toHaveBeenCalledOnce());
            database.rebindAgentSession(created.terminal!.id, 'codex', 'agent-session-b');
            firstProviderResult.resolve({ displayTitle: 'Applied to old Session' });

            await expect(pendingRename).resolves.toMatchObject({
                displayTitle: 'Requested title',
                titleMode: 'manual',
            });
            expect(renameSession).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ agentSessionId: 'agent-session-b' }),
            );
        } finally {
            coordinator.close();
            database.close();
        }
    });

    /**
     * Naming a brand new Agent Session is the very first thing a user does to it, and until the Agent CLI reports a
     * session id there is nothing to synchronize, not a failure to report. Refusing the rename here made that first
     * action fail with "The primary Agent session has not been identified yet" and discarded the typed name with it.
     */
    it('commits a rename locally while the Agent has not reported a session id yet', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-unidentified-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(
            database.createProject(projectRoot).id,
            'codex',
            projectRoot,
        );
        const renameSession = vi.fn();
        const agents = new AgentService(
            undefined,
            createPendingAgentAdapters({
                codex: {
                    provider: 'codex',
                    renameSession,
                    snapshot: () =>
                        Promise.resolve({
                            available: true,
                            observedAt: Date.now(),
                            provider: 'codex',
                            status: 'unknown',
                        }),
                },
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            agents,
            () => {},
            createLogger(join(directory, 'logs')),
        );
        const renameLogger = createLogger(join(directory, 'rename-logs'));
        const write = vi.spyOn(renameLogger, 'write');
        const service = new SessionRenameService(
            database,
            agents,
            coordinator,
            () => {},
            renameLogger,
        );

        try {
            await expect(
                service.rename(created.session.id, 'Untitled no more'),
            ).resolves.toMatchObject({ displayTitle: 'Untitled no more', titleMode: 'manual' });
            expect(renameSession).not.toHaveBeenCalled();
            expect(database.getSession(created.session.id)?.displayTitle).toBe('Untitled no more');
            expect(write).toHaveBeenCalledWith(
                'info',
                logEventCatalog.sessionRename.providerSyncSkipped,
                { fields: { provider: 'codex', reason: 'agent-session-unidentified' } },
            );
        } finally {
            coordinator.close();
            database.close();
        }
    });

    /**
     * A provider with no rename integration is the third branch of the same rule: the title is Caxri's, so it commits
     * locally and the provider write is skipped. The user is never told, because which Agent CLI can be renamed is an
     * implementation detail, and the skip reason stays distinct from an Agent that has simply not started yet.
     */
    it('commits a rename locally when the provider cannot accept one', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-unsupported-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        expect(agentProviderCatalog.grok.capabilities.nativeRename).toBe(false);
        const created = database.createSession(
            database.createProject(projectRoot).id,
            'grok',
            projectRoot,
        );
        database.rebindAgentSession(created.terminal!.id, 'grok', 'agent-session-grok');
        const renameSession = vi.fn();
        const agents = new AgentService(
            undefined,
            createPendingAgentAdapters({ grok: { provider: 'grok', renameSession } }),
        );
        const coordinator = new AgentCoordinator(
            database,
            agents,
            () => {},
            createLogger(join(directory, 'logs')),
        );
        const renameLogger = createLogger(join(directory, 'rename-logs'));
        const write = vi.spyOn(renameLogger, 'write');
        const service = new SessionRenameService(
            database,
            agents,
            coordinator,
            () => {},
            renameLogger,
        );

        try {
            await expect(
                service.rename(created.session.id, 'Named by hand'),
            ).resolves.toMatchObject({ displayTitle: 'Named by hand', titleMode: 'manual' });
            expect(renameSession).not.toHaveBeenCalled();
            expect(database.getSession(created.session.id)).toMatchObject({
                displayTitle: 'Named by hand',
                titleMode: 'manual',
            });
            expect(write).toHaveBeenCalledWith(
                'info',
                logEventCatalog.sessionRename.providerSyncSkipped,
                { fields: { provider: 'grok', reason: 'provider-rename-unsupported' } },
            );
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('serializes concurrent manual renames so the later request wins', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-queue-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(
            database.createProject(projectRoot).id,
            'codex',
            projectRoot,
        );
        database.rebindAgentSession(created.terminal!.id, 'codex', 'agent-session-1');
        const firstProviderResult = Promise.withResolvers<{ displayTitle: string }>();
        const renameSession = vi
            .fn()
            .mockImplementationOnce(() => firstProviderResult.promise)
            .mockResolvedValueOnce({ displayTitle: 'Later title' });
        const agents = new AgentService(
            undefined,
            createPendingAgentAdapters({
                codex: {
                    provider: 'codex',
                    renameSession,
                    snapshot: () => new Promise<never>(() => {}),
                },
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            agents,
            () => {},
            createLogger(join(directory, 'logs')),
        );
        const service = new SessionRenameService(
            database,
            agents,
            coordinator,
            () => {},
            createLogger(join(directory, 'rename-logs')),
        );

        try {
            const earlier = service.rename(created.session.id, 'Earlier title');
            await vi.waitFor(() => expect(renameSession).toHaveBeenCalledOnce());
            /**
             * The queue must hold the second request behind the first provider write. Without it, the slower earlier
             * provider response could commit after the newer title had already been applied.
             */
            const later = service.rename(created.session.id, 'Later title');
            expect(renameSession).toHaveBeenCalledOnce();

            firstProviderResult.resolve({ displayTitle: 'Earlier title' });
            await expect(earlier).resolves.toMatchObject({ displayTitle: 'Earlier title' });
            await expect(later).resolves.toMatchObject({
                displayTitle: 'Later title',
                titleMode: 'manual',
            });
            expect(renameSession).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({ displayTitle: 'Earlier title' }),
            );
            expect(renameSession).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ displayTitle: 'Later title' }),
            );
            expect(database.getSession(created.session.id)?.displayTitle).toBe('Later title');
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
