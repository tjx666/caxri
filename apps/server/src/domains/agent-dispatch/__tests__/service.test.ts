import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDispatchReceipt, Principal, TerminalRecord } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { AgentCoordinator } from '../../agents';
import { CaxriDatabase } from '../../db';
import type { TerminalManager } from '../../terminal';
import { AgentDispatchService } from '../service';

const MAX_DISPATCH_WAITERS = 256;
const MAX_WAITERS_PER_DISPATCH = 32;
const PRINCIPAL: Principal = { kind: 'human-cli', id: 'human-cli:test' };

const temporaryDirectories: string[] = [];
const databases: CaxriDatabase[] = [];
const services: AgentDispatchService[] = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const service of services) service.close();
    services.length = 0;
    for (const database of databases) database.close();
    databases.length = 0;
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function openDatabase(): Promise<CaxriDatabase> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-dispatch-service-'));
    temporaryDirectories.push(directory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    databases.push(database);
    return database;
}

function fakeTerminals(database: CaxriDatabase) {
    const processIds = new Map<string, number>();
    const agentProcessIds = new Map<string, number>();
    const markRunning = (terminalId: string): TerminalRecord => {
        database.updateTerminalState(terminalId, 'running');
        database.updateAgentProcessState(terminalId, 'running');
        agentProcessIds.set(terminalId, 5_242);
        return database.getTerminal(terminalId)!;
    };
    return {
        agentProcessId: (terminalId: string) => agentProcessIds.get(terminalId),
        processId: (terminalId: string) => processIds.get(terminalId),
        start: (terminal: TerminalRecord) => {
            processIds.set(terminal.id, 4_242);
            return Promise.resolve(markRunning(terminal.id));
        },
        restart: (terminalId: string) => {
            processIds.set(terminalId, 4_243);
            return Promise.resolve(markRunning(terminalId));
        },
        signalAgentExact: vi.fn(() => true),
        waitForAgentRunning: vi.fn(() => Promise.resolve()),
    } as unknown as TerminalManager;
}

function createService(
    database: CaxriDatabase,
    terminals: TerminalManager = fakeTerminals(database),
    endpoints: AgentEndpointLifecycle = {
        endpointForTerminal: (terminalId: string) => ({
            launchId: `launch-${terminalId}`,
            terminalId,
            ref: {
                hostId: 'host-1',
                endpointId: `endpoint-${terminalId}`,
                generation: 1,
            },
        }),
    } as AgentEndpointLifecycle,
) {
    const service = new AgentDispatchService({
        database,
        coordinator: {
            prepareTerminalStart: vi.fn(),
            prepareTerminalResume: vi.fn(),
            probeTerminal: vi.fn(),
        } as unknown as AgentCoordinator,
        terminals,
        endpoints,
        launchSettings: () => ({ executable: '/fixture/codex', args: [] }),
        terminalDirectoryIdentity: (path) => Promise.resolve({ device: '1', inode: '1', path }),
        terminalWorkingDirectory: (projectRoot) => Promise.resolve(projectRoot),
        emit: vi.fn(),
    });
    services.push(service);
    return service;
}

async function seededDispatch() {
    const database = await openDatabase();
    const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
    const { session } = database.createSession(project.id, 'shell');
    const service = createService(database);
    return { database, project, service, session };
}

describe('AgentDispatchService', () => {
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

    it.each([
        ['stopped', { status: 'stopped' }],
        ['interrupted', { status: 'interrupted' }],
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

    it('marks a running dispatch interrupted when the terminal returns to starting', async () => {
        const { project, service, session } = await seededDispatch();
        const receipt = await service.start('dispatch-1', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });

        service.observeTerminalState(receipt.terminalId!, 'starting');
        expect(service.status(receipt.dispatchId, null)).toMatchObject({ status: 'interrupted' });
    });
});
