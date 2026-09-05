import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionRenameService } from '../session-rename';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Session rename', () => {
    it('persists local-only Session names under manual ownership', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-session-rename-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
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

    it('persists the Agent-native Session name only after the provider accepts it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-session-rename-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const events: ServerEvent[] = [];
        const providerAcceptance = Promise.withResolvers<{ displayTitle: string }>();
        const renameSession = vi
            .fn()
            .mockImplementationOnce(() => providerAcceptance.promise)
            .mockRejectedValueOnce(new CaxriError('UNAVAILABLE', 'Codex rename failed'));
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => events.push(event),
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
            agentAdapters: createPendingAgentAdapters({
                codex: {
                    provider: 'codex',
                    renameSession,
                    snapshot: () =>
                        Promise.resolve({
                            available: true,
                            observedAt: Date.now(),
                            provider: 'codex',
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
                defaultAgent: 'codex',
            });

            const pendingRename = runtime.handlers['session.rename']({
                sessionId: created.session.id,
                displayTitle: 'Focused investigation',
            });
            await vi.waitFor(() => expect(renameSession).toHaveBeenCalledOnce());
            const pendingState = await runtime.handlers['app.bootstrap']({});
            expect(
                pendingState.sessions.find((session) => session.id === created.session.id),
                // The probe has already replaced the neutral default with the provider placeholder; the point here is
                // that the requested manual title is not persisted until the provider accepts it.
            ).toMatchObject({ displayTitle: 'Codex session', titleMode: 'automatic' });

            providerAcceptance.resolve({ displayTitle: 'Focused investigation (2)' });
            await expect(pendingRename).resolves.toMatchObject({
                displayTitle: 'Focused investigation (2)',
                titleMode: 'manual',
            });
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
                displayTitle: 'Focused investigation (2)',
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
            new StructuredLogger(join(directory, 'logs')),
        );
        const service = new SessionRenameService(database, agents, coordinator, () => {});

        try {
            const pendingRename = service.rename(created.session.id, 'Requested title');
            await vi.waitFor(() => expect(renameSession).toHaveBeenCalledOnce());
            database.rebindAgentSession(created.terminal!.id, 'codex', 'agent-session-b');
            firstProviderResult.resolve({ displayTitle: 'Applied to old Session' });

            await expect(pendingRename).resolves.toMatchObject({
                displayTitle: 'Applied to resumed Session',
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

    it('serializes automatic and manual provider renames so the manual title wins', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-auto-rename-queue-'));
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
        const automaticProviderResult = Promise.withResolvers<{ displayTitle: string }>();
        const renameSession = vi
            .fn()
            .mockImplementationOnce(() => automaticProviderResult.promise)
            .mockResolvedValueOnce({ displayTitle: 'Manual title' });
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
            new StructuredLogger(join(directory, 'logs')),
        );
        const service = new SessionRenameService(database, agents, coordinator, () => {});

        try {
            const automatic = service.renameAutomatically(
                created.session.id,
                '🧭 Automatic title',
                () => true,
            );
            await vi.waitFor(() => expect(renameSession).toHaveBeenCalledOnce());
            const manual = service.rename(created.session.id, 'Manual title');
            expect(renameSession).toHaveBeenCalledOnce();

            automaticProviderResult.resolve({ displayTitle: '🧭 Automatic title' });
            await expect(automatic).resolves.toBe('🧭 Automatic title');
            await expect(manual).resolves.toMatchObject({
                autoNamingState: 'stopped',
                displayTitle: 'Manual title',
                titleMode: 'manual',
            });
            expect(renameSession).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({ displayTitle: '🧭 Automatic title' }),
            );
            expect(renameSession).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ displayTitle: 'Manual title' }),
            );
            expect(database.sessionNaming.get(created.session.id)).toEqual({
                state: 'stopped',
            });
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('drops an automatic rename when its provider binding changes during ownership verification', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-auto-rename-guard-'));
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
        const ownership = Promise.withResolvers<boolean>();
        const ownershipGuard = vi.fn(() => ownership.promise);
        const renameSession = vi.fn(() => Promise.resolve({ displayTitle: 'Must not apply' }));
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
            new StructuredLogger(join(directory, 'logs')),
        );
        const service = new SessionRenameService(database, agents, coordinator, () => {});

        try {
            const automatic = service.renameAutomatically(
                created.session.id,
                '🧭 Automatic title',
                () =>
                    database.getTerminal(created.terminal!.id)?.agentSessionId ===
                    'agent-session-a',
                undefined,
                ownershipGuard,
            );
            await vi.waitFor(() => expect(ownershipGuard).toHaveBeenCalledOnce());
            database.rebindAgentSession(created.terminal!.id, 'codex', 'agent-session-b');
            ownership.resolve(true);

            await expect(automatic).resolves.toBeUndefined();
            expect(renameSession).not.toHaveBeenCalled();
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('serializes Resume before a newer manual rename so the manual intent wins', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-resume-queue-'));
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
        database.renameSession(created.session.id, 'Initial manual title');
        const agents = new AgentService(
            undefined,
            createPendingAgentAdapters({
                codex: {
                    provider: 'codex',
                    renameSession: () => Promise.resolve({ displayTitle: 'Newer manual title' }),
                    snapshot: () => new Promise<never>(() => {}),
                },
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            agents,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
        );
        const service = new SessionRenameService(database, agents, coordinator, () => {});

        try {
            const resume = service.resumeAutomaticNaming(created.session.id);
            const manual = service.rename(created.session.id, 'Newer manual title');

            await expect(resume).resolves.toMatchObject({ autoNamingState: 'active' });
            await expect(manual).resolves.toMatchObject({
                autoNamingState: 'stopped',
                displayTitle: 'Newer manual title',
                titleMode: 'manual',
            });
            expect(database.sessionNaming.get(created.session.id)).toEqual({ state: 'stopped' });
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
