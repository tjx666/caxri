import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentDispatchReceipt, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { logEventCatalog, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { TerminalManager } from '../../terminal';
import type { AgentDispatchService } from '../service';
import {
    closeDispatchFixtures,
    createService,
    fakeTerminals,
    openDatabase,
    PRINCIPAL,
    seededDispatch,
    temporaryDirectories,
} from './dispatch-service.fixture';

const MAX_DISPATCH_WAITERS = 256;
const MAX_WAITERS_PER_DISPATCH = 32;

afterEach(async () => {
    vi.useRealTimers();
    await closeDispatchFixtures();
});

/**
 * Holds the last await before a start persists anything (and before a resume launches), so a test can archive the
 * Session exactly where a real `session.archive` would interleave with path validation.
 */
function heldDirectoryIdentity() {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    return {
        entered: entered.promise,
        release: () => released.resolve(),
        identity: async (path: string) => {
            entered.resolve();
            await released.promise;
            return { device: '1', inode: '1', path };
        },
    };
}

describe('AgentDispatchService', () => {
    it.each(['terminal', 'session'] as const)(
        'preserves %s close before Agent launch registration through the real TerminalManager',
        async (target) => {
            const database = await openDatabase();
            const directory = await realpath(temporaryDirectories.at(-1)!);
            const project = database.createProject(directory);
            const { session } = database.createSession(project.id, 'shell');
            const logger = new StructuredLogger(join(directory, 'logs'));
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const spawn = vi.fn(() => {
                throw new Error('Closed Terminal must not spawn');
            });
            const dispatchState: { service?: AgentDispatchService } = {};
            const terminals = createTestTerminalManager(database, () => {}, logger, {
                spawn,
                agentEnvironment: () => Promise.resolve({ PATH: '/fixture' }),
                agentLaunchSettings: () => ({ executable: '/fixture/codex', args: [] }),
                resolveExecutable: async (kind) => {
                    entered.resolve();
                    await release.promise;
                    return kind === 'shell' ? '/bin/zsh' : '/fixture/codex';
                },
                onAgentStateChanged: (terminalId, state, cause) =>
                    dispatchState.service?.observeTerminalState(terminalId, state, cause),
            });
            const service = createService(database, terminals, undefined, logger, async (path) => {
                const stats = await lstat(path, { bigint: true });
                return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
            });
            dispatchState.service = service;
            const launching = service.start('close-before-registration', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
            });
            try {
                await entered.promise;
                const starting = service.status('close-before-registration', null);
                expect(starting.status).toBe('starting');
                if (target === 'terminal') terminals.close(starting.terminalId!);
                else {
                    terminals.terminateSession(session.id);
                    database.deleteSession(session.id);
                }
                release.resolve();
                const receipt = await launching;
                expect(receipt.status).toBe('stopped');
                expect(receipt.failure).toBeUndefined();
                expect(spawn).not.toHaveBeenCalled();
            } finally {
                release.resolve();
                await launching;
                await logger.flush();
            }
        },
    );

    it('reports real resume preparation failure without retiring the new dispatch', async () => {
        const database = await openDatabase();
        const directory = await realpath(temporaryDirectories.at(-1)!);
        const project = database.createProject(directory);
        const { session, terminal } = database.createSession(project.id, 'codex');
        database.database
            .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
            .run('codex-session-1', terminal!.id);
        database.updateTerminalState(terminal!.id, 'stopped');
        database.updateAgentProcessState(terminal!.id, 'stopped');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const dispatchState: { service?: AgentDispatchService } = {};
        const terminals = createTestTerminalManager(database, () => {}, logger, {
            agentEnvironment: () => Promise.resolve({ PATH: '/fixture' }),
            resolveExecutable: async () => {
                entered.resolve();
                await release.promise;
                throw new CaxriError('UNAVAILABLE', 'Fixture executable unavailable');
            },
            onAgentStateChanged: (id, state, cause) =>
                dispatchState.service?.observeTerminalState(id, state, cause),
        });
        const service = createService(database, terminals, undefined, logger, async (path) => {
            const stats = await lstat(path, { bigint: true });
            return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
        });
        dispatchState.service = service;
        const launching = service.resume('real-resume-failure', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            terminalId: terminal!.id,
            providerSessionId: 'codex-session-1',
        });
        try {
            await entered.promise;
            expect(service.status('real-resume-failure', null).status).toBe('starting');
            release.resolve();
            expect(await launching).toMatchObject({
                status: 'failed',
                failure: { reason: 'launch_failed' },
            });
        } finally {
            release.resolve();
            await launching;
            await logger.flush();
        }
    });

    it.each(['terminalClosed', 'serverShutdown'] as const)(
        'preserves intentional %s during launch',
        async (cause) => {
            const database = await openDatabase();
            const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
            const { session } = database.createSession(project.id, 'shell');
            const terminals = fakeTerminals(database);
            const service = createService(database, terminals);
            terminals.waitForAgentRunning = vi.fn((terminalId: string) => {
                database.updateAgentProcessState(terminalId, 'stopped');
                service.observeTerminalState(terminalId, 'stopped', cause);
                return Promise.reject(new CaxriError('UNAVAILABLE', 'Managed Agent did not start'));
            });
            const receipt = await service.start('closed-before-running', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
            });
            expect(receipt.status).toBe('stopped');
            expect(receipt.failure).toBeUndefined();
        },
    );

    it.each([
        ['suspended', 'idleSuspended', 'idleSuspended'],
        ['suspended', 'sessionArchived', 'sessionArchived'],
        ['detached', undefined, 'userDetached'],
        ['interrupted', 'hostRestart', 'hostRestart'],
        ['interrupted', 'terminalRestart', 'terminalRestart'],
    ] as const)(
        'logs the causal %s transition without launch contents',
        async (state, cause, reason) => {
            const database = await openDatabase();
            const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
            const { session } = database.createSession(project.id, 'shell');
            const write = vi.fn<StructuredLogger['write']>();
            const service = createService(database, undefined, undefined, { write } as never);
            const receipt = await service.start('causal-receipt', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
            });
            service.observeTerminalState(receipt.terminalId!, state, cause);
            service.observeTerminalState(receipt.terminalId!, state, cause);
            expect(write.mock.calls.map((call) => call[2]?.fields?.reason)).toEqual([
                'created',
                'launchReady',
                reason,
            ]);
            const fields = write.mock.calls.at(-1)?.[2]?.fields;
            expect(fields?.durationMs).toBeGreaterThanOrEqual(0);
            expect(fields).toEqual({
                dispatchId: receipt.dispatchId,
                terminalId: receipt.terminalId,
                previousStatus: 'running',
                status: 'interrupted',
                reason,
                durationMs: fields?.durationMs,
            });
        },
    );

    it('records an immediate successful process exit during launch as launch failure', async () => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session } = database.createSession(project.id, 'shell');
        const terminals = fakeTerminals(database);
        const service = createService(database, terminals);
        terminals.waitForAgentRunning = vi.fn((terminalId: string) => {
            database.updateAgentProcessState(terminalId, 'stopped');
            service.observeTerminalState(terminalId, 'stopped');
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Managed Agent did not start'));
        });
        const receipt = await service.start('exit-before-running', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });
        expect(receipt).toMatchObject({
            status: 'failed',
            failure: { code: 'UNAVAILABLE', reason: 'launch_failed' },
        });
    });

    it('rolls back a child whose visible layout preparation fails before launch', async () => {
        const { database, project, service, session } = await seededDispatch();
        const terminals = database.listTerminals(session.id);
        const layout = database.getSessionState(session.id).paneLayout;
        const receipt = await service.start(
            'layout-failure',
            PRINCIPAL,
            { projectId: project.id, sessionId: session.id, provider: 'claude' },
            {
                launch: { executable: 'claude', args: [] },
                prepared: () => {
                    throw new Error('No visible pane capacity');
                },
            },
        );
        expect(receipt.status).toBe('failed');
        expect(database.listTerminals(session.id)).toEqual(terminals);
        expect(database.getSessionState(session.id).paneLayout).toEqual(layout);
    });

    it('refuses a start whose Session is archived while its working directory is validated', async () => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session } = database.createSession(project.id, 'shell');
        const terminals = fakeTerminals(database);
        const start = vi.spyOn(terminals, 'start');
        const held = heldDirectoryIdentity();
        const service = createService(database, terminals, undefined, undefined, held.identity);
        const before = database.listTerminals(session.id);
        const starting = service.start('archived-mid-start', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });
        await held.entered;
        database.archiveSession(session.id);
        held.release();

        await expect(starting).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(database.listTerminals(session.id)).toEqual(before);
        expect(database.getAgentDispatch('archived-mid-start')).toBeUndefined();
        expect(start).not.toHaveBeenCalled();
    });

    it('refuses a resume whose Session is archived while its working directory is validated', async () => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session, terminal } = database.createSession(project.id, 'codex');
        database.database
            .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
            .run('codex-session-1', terminal!.id);
        database.updateTerminalState(terminal!.id, 'stopped');
        const terminals = fakeTerminals(database);
        const restart = vi.spyOn(terminals, 'restart');
        const held = heldDirectoryIdentity();
        const service = createService(database, terminals, undefined, undefined, held.identity);
        const resuming = service.resume('archived-mid-resume', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            terminalId: terminal!.id,
            providerSessionId: 'codex-session-1',
        });
        await held.entered;
        database.archiveSession(session.id);
        held.release();

        await expect(resuming).resolves.toMatchObject({
            status: 'failed',
            failure: { code: 'CONFLICT', reason: 'launch_failed' },
        });
        expect(restart).not.toHaveBeenCalled();
        expect(database.getTerminal(terminal!.id)?.lastProcessState).toBe('stopped');
    });

    it('passes the exact bound Provider session into the resume launch path', async () => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session, terminal } = database.createSession(project.id, 'codex');
        database.database
            .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
            .run('codex-session-1', terminal!.id);
        database.updateTerminalState(terminal!.id, 'stopped');
        let agentProcessId: number | undefined;
        const restart = vi.fn((terminalId: string) => {
            database.updateTerminalState(terminalId, 'running');
            database.updateAgentProcessState(terminalId, 'running');
            agentProcessId = 5_243;
            return Promise.resolve(database.getTerminal(terminalId)!);
        });
        const terminals = {
            agentLaunchId: () => 'synthetic-launch',
            agentProcessId: () => agentProcessId,
            processId: () => 4_243,
            restart,
            signalAgentExact: vi.fn(() => true),
            waitForAgentRunning: vi.fn(() => Promise.resolve()),
        } as unknown as TerminalManager;
        const service = createService(database, terminals);

        await expect(
            service.resume('dispatch-resume-1', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                terminalId: terminal!.id,
                providerSessionId: 'codex-session-1',
            }),
        ).resolves.toMatchObject({ operation: 'resume', status: 'running' });
        expect(restart).toHaveBeenCalledWith(
            terminal!.id,
            expect.objectContaining({ resumeAgentSessionId: 'codex-session-1' }),
        );
    });

    it('resumes a stopped Agent while its outer Shell remains running', async () => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session, terminal } = database.createSession(project.id, 'codex');
        database.database
            .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
            .run('codex-session-1', terminal!.id);
        database.updateTerminalState(terminal!.id, 'running');
        database.updateAgentProcessState(terminal!.id, 'stopped');
        let agentProcessId: number | undefined;
        const restart = vi.fn((terminalId: string) => {
            database.updateAgentProcessState(terminalId, 'running');
            agentProcessId = 5_243;
            return Promise.resolve(database.getTerminal(terminalId)!);
        });
        const terminals = {
            agentLaunchId: () => 'synthetic-launch',
            agentProcessId: () => agentProcessId,
            processId: () => 4_243,
            restart,
            signalAgentExact: vi.fn(() => true),
            waitForAgentRunning: vi.fn(() => Promise.resolve()),
        } as unknown as TerminalManager;
        const service = createService(database, terminals);

        await expect(
            service.resume('dispatch-resume-shell-running', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                terminalId: terminal!.id,
                providerSessionId: 'codex-session-1',
            }),
        ).resolves.toMatchObject({ status: 'running' });
        expect(restart).toHaveBeenCalledOnce();
    });

    it('rejects resume when a managed Agent process is still present', async () => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session, terminal } = database.createSession(project.id, 'codex');
        database.database
            .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
            .run('codex-session-1', terminal!.id);
        database.updateTerminalState(terminal!.id, 'running');
        database.updateAgentProcessState(terminal!.id, 'stopped');
        const terminals = {
            agentLaunchId: () => 'synthetic-launch',
            agentProcessId: () => 5_243,
            processId: () => 4_243,
        } as unknown as TerminalManager;
        const service = createService(database, terminals);

        await expect(
            service.resume('dispatch-resume-live-agent', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                terminalId: terminal!.id,
                providerSessionId: 'codex-session-1',
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('waits for the managed Agent and requires its durable and live state', async () => {
        const database = await openDatabase();
        const waitForAgentRunning = vi.fn((terminalId: string) => {
            database.updateAgentProcessState(terminalId, 'running');
            return Promise.resolve();
        });
        const terminals = {
            agentProcessId: () => 5_244,
            processId: () => 4_244,
            start: (terminal: TerminalRecord) => {
                database.updateTerminalState(terminal.id, 'running');
                return Promise.resolve(database.getTerminal(terminal.id)!);
            },
            signalAgentExact: vi.fn(() => true),
            waitForAgentRunning,
        } as unknown as TerminalManager;
        const service = createService(database, terminals);
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session } = database.createSession(project.id, 'shell');

        await expect(
            service.start('dispatch-wait-agent', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
            }),
        ).resolves.toMatchObject({ status: 'running' });
        expect(waitForAgentRunning).toHaveBeenCalledOnce();
    });

    it('signals the prepared Agent generation when Endpoint activation is missing', async () => {
        const database = await openDatabase();
        const terminals = fakeTerminals(database);
        const signalAgentExact = vi.spyOn(terminals, 'signalAgentExact');
        const endpoints = {
            endpointForTerminal: vi.fn(() => {}),
            preparedEndpointForTerminal: vi.fn((terminalId: string) => ({
                launchId: 'launch-prepared',
                terminalId,
                ref: { hostId: 'host-1', endpointId: 'endpoint-prepared', generation: 1 },
            })),
        } as unknown as AgentEndpointLifecycle;
        const service = createService(database, terminals, endpoints);
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session } = database.createSession(project.id, 'shell');

        await expect(
            service.start('dispatch-no-active-endpoint', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
            }),
        ).resolves.toMatchObject({ status: 'failed' });
        expect(signalAgentExact).toHaveBeenCalledWith(
            expect.any(String),
            'launch-prepared',
            'SIGHUP',
        );
    });

    it('rejects a reused dispatch id whose command fingerprint does not match', async () => {
        const { project, service, session } = await seededDispatch();
        const input = { projectId: project.id, sessionId: session.id, provider: 'codex' as const };
        await service.start('dispatch-1', PRINCIPAL, input);

        await expect(
            service.start('dispatch-1', PRINCIPAL, { ...input, provider: 'claude' }),
        ).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringMatching(/cannot be reused/i) as string,
        });
    });

    it('returns the original receipt when the same start is replayed', async () => {
        const { project, service, session } = await seededDispatch();
        const input = { projectId: project.id, sessionId: session.id, provider: 'codex' as const };
        const first = await service.start('dispatch-1', PRINCIPAL, input);
        const replayed = await service.start('dispatch-1', PRINCIPAL, input);
        expect(replayed).toEqual(first);
        expect(first.status).toBe('running');
    });

    it('rejects a thirty-third waiter on one dispatch', async () => {
        const { project, service, session } = await seededDispatch();
        const receipt = await service.start('dispatch-1', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });
        const pending = Array.from({ length: MAX_WAITERS_PER_DISPATCH }, (_, index) =>
            service.wait(receipt.dispatchId, null, receipt.revision, 60_000, `wait-${index}`),
        );
        expect(pending).toHaveLength(MAX_WAITERS_PER_DISPATCH);

        expect(() =>
            service.wait(receipt.dispatchId, null, receipt.revision, 60_000, 'wait-overflow'),
        ).toThrow(expect.objectContaining({ code: 'CAPACITY' }) as Error);
    });

    it('rejects a waiter once the global pending-wait cap is reached', async () => {
        const { project, service, session } = await seededDispatch();
        const neededDispatches = Math.ceil((MAX_DISPATCH_WAITERS + 1) / MAX_WAITERS_PER_DISPATCH);
        const receipts: AgentDispatchReceipt[] = await Promise.all(
            Array.from({ length: neededDispatches }, (_, index) =>
                service.start(`dispatch-${index}`, PRINCIPAL, {
                    projectId: project.id,
                    sessionId: session.id,
                    provider: 'codex',
                }),
            ),
        );

        let remaining = MAX_DISPATCH_WAITERS;
        const pending: Array<ReturnType<AgentDispatchService['wait']>> = [];
        for (const receipt of receipts) {
            const count = Math.min(MAX_WAITERS_PER_DISPATCH, remaining);
            for (let index = 0; index < count; index += 1) {
                pending.push(
                    service.wait(
                        receipt.dispatchId,
                        null,
                        receipt.revision,
                        60_000,
                        `${receipt.dispatchId}-wait-${index}`,
                    ),
                );
            }
            remaining -= count;
        }
        expect(pending).toHaveLength(MAX_DISPATCH_WAITERS);

        const overflow = receipts.at(-1)!;
        expect(() =>
            service.wait(overflow.dispatchId, null, overflow.revision, 60_000, 'global-overflow'),
        ).toThrow(expect.objectContaining({ code: 'CAPACITY' }) as Error);
    });

    it('times out a wait that never sees a later revision', async () => {
        vi.useFakeTimers();
        const { project, service, session } = await seededDispatch();
        const receipt = await service.start('dispatch-1', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });
        const waiting = service.wait(
            receipt.dispatchId,
            null,
            receipt.revision,
            25,
            'wait-timeout',
        );

        await vi.advanceTimersByTimeAsync(25);
        await expect(waiting).resolves.toMatchObject({
            outcome: 'timed_out',
            receipt: { dispatchId: receipt.dispatchId, revision: receipt.revision },
        });
    });

    it('cancels a pending wait by wait id', async () => {
        const { project, service, session } = await seededDispatch();
        const receipt = await service.start('dispatch-1', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });
        const waiting = service.wait(receipt.dispatchId, null, receipt.revision, 60_000, 'wait-1');

        expect(service.cancelWait('wait-1')).toBe(true);
        await expect(waiting).resolves.toMatchObject({
            outcome: 'canceled',
            receipt: { dispatchId: receipt.dispatchId },
        });
        expect(service.cancelWait('wait-1')).toBe(false);
    });

    it.each(['suspended', 'detached'] as const)(
        'releases a pending wait as interrupted when the terminal becomes %s',
        async (state) => {
            const { project, service, session } = await seededDispatch();
            const receipt = await service.start('dispatch-1', PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
            });
            const waiting = service.wait(
                receipt.dispatchId,
                null,
                receipt.revision,
                60_000,
                `wait-${state}`,
            );

            service.observeTerminalState(receipt.terminalId!, state);
            await expect(waiting).resolves.toMatchObject({
                outcome: 'changed',
                receipt: { dispatchId: receipt.dispatchId, status: 'interrupted' },
            });
        },
    );

    it.each([
        ['stopped', { status: 'stopped' }],
        ['interrupted', { status: 'interrupted' }],
        ['suspended', { status: 'interrupted' }],
        ['detached', { status: 'interrupted' }],
        ['dead', { status: 'failed', failure: { code: 'UNAVAILABLE', reason: 'process_failed' } }],
        [
            'failed',
            { status: 'failed', failure: { code: 'UNAVAILABLE', reason: 'process_failed' } },
        ],
    ] as const)('maps terminal state %s onto the dispatch receipt', async (state, expected) => {
        const { project, service, session } = await seededDispatch();
        const receipt = await service.start('dispatch-1', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });

        service.observeTerminalState(receipt.terminalId!, state);
        expect(service.status(receipt.dispatchId, null)).toMatchObject(expected);
    });

    /**
     * Retiring runs before the durable event journal exists, and that journal's startup queue holds fewer events than
     * the receipt table holds rows, so one event per dispatch could stop Server Core from starting.
     */
    it('retires active dispatches on Server restart without announcing each one', async () => {
        const { database, project, service, session } = await seededDispatch();
        const dispatchIds = ['dispatch-1', 'dispatch-2'];
        const start = (dispatchId: string) =>
            service.start(dispatchId, PRINCIPAL, {
                projectId: project.id,
                sessionId: session.id,
                provider: 'codex',
            });
        await start('dispatch-1');
        await start('dispatch-2');
        const emit = vi.fn();
        const logger = {
            write: vi.fn<(level: string, event: unknown, entry: { fields: object }) => void>(),
        };
        const restarted = createService(
            database,
            undefined,
            undefined,
            logger as never,
            undefined,
            emit,
        );

        restarted.initialize();

        for (const dispatchId of dispatchIds)
            expect(restarted.status(dispatchId, null)).toMatchObject({
                status: 'failed',
                failure: { code: 'UNAVAILABLE', reason: 'host_reset' },
            });
        expect(emit).not.toHaveBeenCalled();
        expect(logger.write.mock.calls).toEqual(
            dispatchIds.map((dispatchId) => [
                'info',
                logEventCatalog.agentDispatch.transitioned,
                {
                    fields: expect.objectContaining({
                        dispatchId,
                        previousStatus: 'running',
                        status: 'failed',
                        reason: 'hostRestart',
                    }) as object,
                },
            ]),
        );
    });

    it('marks a running dispatch interrupted through the restart retirement event', async () => {
        const { project, service, session } = await seededDispatch();
        const receipt = await service.start('dispatch-1', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });

        service.observeTerminalState(receipt.terminalId!, 'interrupted', 'terminalRestart');
        expect(service.status(receipt.dispatchId, null)).toMatchObject({ status: 'interrupted' });
    });

    /**
     * `terminals.start` joins a launch already in flight, so a manual restart that wins the race still returns
     * successfully to the dispatch that lost it. The delegation reports `interrupted`/`target_changed` for that case,
     * and the receipt has to agree instead of claiming the user's process as its own running Agent.
     */
    it.each([
        { basis: 'keeps the Terminal', isTakenOver: false, status: 'running' },
        {
            basis: 'loses the Terminal to a manual start',
            failure: { code: 'CONFLICT', reason: 'target_changed' },
            isTakenOver: true,
            status: 'interrupted',
        },
    ])('settles a dispatch that $basis', async ({ failure, isTakenOver, status }) => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session } = database.createSession(project.id, 'shell');
        const base = fakeTerminals(database);
        const signalAgentExact = vi.spyOn(base, 'signalAgentExact');
        let isOwned = true;
        const terminals = {
            ...base,
            start: async (terminal: TerminalRecord, options?: unknown) => {
                const started = await (
                    base as unknown as {
                        start: (terminal: TerminalRecord, options?: unknown) => Promise<unknown>;
                    }
                ).start(terminal, options);
                // The user's own start lands while this dispatch's launch is still in flight.
                if (isTakenOver) isOwned = false;
                return started;
            },
        } as unknown as TerminalManager;
        const service = createService(database, terminals);

        const receipt = await service.start(
            'dispatch-manual-takeover',
            PRINCIPAL,
            { projectId: project.id, sessionId: session.id, provider: 'codex' },
            {
                launch: { executable: '/fixture/codex', args: [] },
                prepared: () => {},
                shouldStart: () => isOwned,
            },
        );

        expect(receipt.status).toBe(status);
        expect(receipt.failure).toEqual(failure);
        // The process that came up is the user's, so settling the lost dispatch must not tear it down.
        expect(signalAgentExact).not.toHaveBeenCalled();
        expect(database.getTerminal(receipt.terminalId!)?.lastAgentProcessState).toBe('running');
    });
});
