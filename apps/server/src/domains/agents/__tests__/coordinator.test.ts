import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider, ServerEvent } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

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

function createAgents(snapshot: AgentAdapter['snapshot']): AgentService {
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const adapters = Object.fromEntries(
        agentProviderIds.map((provider) => [provider, { provider, renameSession, snapshot }]),
    ) as Record<AgentProvider, AgentAdapter>;
    return new AgentService(undefined, adapters);
}

afterEach(async () => {
    await flushLoggers();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('AgentCoordinator', () => {
    it('correlates Agent metadata against the persisted Terminal cwd', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-cwd-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const terminalRoot = join(directory, 'terminal');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(
            database.createProject(projectRoot).id,
            'codex',
            terminalRoot,
        );
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'unknown',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
        );

        try {
            coordinator.probeTerminal(created.terminal!.id);
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
            expect(snapshot.mock.calls[0]?.[0].rootPath).toBe(terminalRoot);
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it.each(agentProviderIds)(
        'promotes a Shell Terminal after a direct %s command creates Agent metadata',
        async (provider) => {
            const directory = await mkdtemp(join(tmpdir(), `caxri-shell-${provider}-`));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'shell');
            const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
                Promise.resolve({
                    provider,
                    status: 'running',
                    observedAt: Date.now(),
                    available: true,
                    sessionId: `${provider}-session`,
                    title: `${provider} from Shell`,
                    ...(!context.startedAt && { sessionId: undefined }),
                }),
            );
            const coordinator = new AgentCoordinator(
                database,
                createAgents(snapshot),
                () => {},
                createLogger(join(directory, 'logs')),
                { refreshDelayMs: 5 },
            );

            const terminalId = created.terminal!.id;
            try {
                coordinator.observeInput(terminalId, `echo ${provider}\r`);
                coordinator.observeOutput(created.terminal!.id);
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(snapshot).not.toHaveBeenCalled();

                const command = `${agentProviderCatalog[provider].executableName}\r`;
                coordinator.observeInput(terminalId, command);
                coordinator.observeOutput(created.terminal!.id);

                await expect
                    .poll(() => database.getTerminal(created.terminal!.id)?.provider)
                    .toBe(provider);
                // The tab follows the Agent's own conversation title, not the provider name it was promoted with: an
                // Agent CLI never reports that title through OSC 0/2, so without this every Agent tab reads "Claude".
                expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                    agentSessionId: `${provider}-session`,
                    kind: provider,
                    title: `${provider} from Shell`,
                });
                expect(database.getSession(created.session.id)).toMatchObject({
                    title: `${provider} from Shell`,
                    primaryAgentTerminalId: created.terminal!.id,
                });
            } finally {
                await coordinator.close();
                database.close();
            }
        },
    );

    it('promotes a Shell alias as soon as its foreground Codex process is confirmed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-codex-alias-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const detectForegroundAgent = vi.fn(() => Promise.resolve('codex' as const));
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'cxy\r');
            coordinator.observeOutput(created.terminal!.id, 4242);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.provider)
                .toBe('codex');
            expect(detectForegroundAgent).toHaveBeenCalledWith(4242);
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                agentSessionId: undefined,
                kind: 'codex',
                title: 'Codex',
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                title: 'Untitled',
                primaryAgentTerminalId: created.terminal!.id,
            });
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('bounds foreground process probes for a chatty non-Agent command', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-probe-bound-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const detectForegroundAgent = vi.fn(() => Promise.resolve(undefined));
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.reject(new Error('metadata probing must not run without a provider')),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );
        /**
         * Fake only Date so the probe-interval clock advances without touching real timers.
         */
        vi.useFakeTimers({ toFake: ['Date'] });

        try {
            coordinator.observeInput(created.terminal!.id, 'tail -f dev.log\r');
            // Simulate a long-lived command emitting output far past the probe budget.
            for (let round = 0; round < 10; round += 1) {
                for (let chunk = 0; chunk < 20; chunk += 1)
                    coordinator.observeOutput(created.terminal!.id, 4242);
                // eslint-disable-next-line no-await-in-loop -- each round must advance the fake clock only after the prior round's output settles
                await new Promise((resolve) => setTimeout(resolve, 5));
                vi.setSystemTime(Date.now() + 2_100);
            }
            expect(detectForegroundAgent.mock.calls.length).toBeLessThanOrEqual(5);
            expect(snapshot).not.toHaveBeenCalled();
            expect(database.getTerminal(created.terminal!.id)?.provider).toBeUndefined();
        } finally {
            vi.useRealTimers();
            await coordinator.close();
            database.close();
        }
    });

    it('keeps a Shell Terminal unchanged when an Agent command has no matching metadata', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-unconfirmed-agent-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'claude\r');
            await expect.poll(() => snapshot.mock.calls.length).toBe(3);
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                agentSessionId: undefined,
                kind: 'shell',
                provider: undefined,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                title: 'Untitled',
                primaryAgentTerminalId: undefined,
            });
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('does not bind concurrent same-root Agent Terminals to one Agent session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-correlation-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const second = database.createTerminal(created.session.id, 'codex');
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) => {
            const excluded = context.excludedAgentSessionIds ?? [];
            return Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: excluded.includes('agent-session-1')
                    ? 'agent-session-2'
                    : 'agent-session-1',
            });
        });
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.prepareTerminalStart(created.terminal!.id);
            coordinator.prepareTerminalStart(second.id);
            coordinator.probeTerminal(created.terminal!.id);
            coordinator.probeTerminal(second.id);

            await expect
                .poll(() =>
                    [created.terminal!.id, second.id]
                        .map((id) => database.getTerminal(id)?.agentSessionId)
                        .filter((agentSessionId): agentSessionId is string =>
                            Boolean(agentSessionId),
                        )
                        .toSorted((a, b) => a.localeCompare(b)),
                )
                .toEqual(['agent-session-1', 'agent-session-2']);
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('excludes the previous Agent session when a Terminal restarts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-restart-correlation-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'codex',
            status: 'running',
            observedAt: Date.now(),
            available: true,
            sessionId: 'old-agent-session',
            title: 'Old title',
        });
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: context.excludedAgentSessionIds?.includes('old-agent-session')
                    ? 'new-agent-session'
                    : 'old-agent-session',
                title: 'New title',
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
        );

        try {
            coordinator.prepareTerminalStart(created.terminal!.id);
            coordinator.probeTerminal(created.terminal!.id);
            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.agentSessionId)
                .toBe('new-agent-session');
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('ignores an old Agent probe that resolves after a fresh restart begins', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-stale-probe-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'codex',
            status: 'running',
            observedAt: Date.now(),
            available: true,
            sessionId: 'old-agent-session',
        });
        const pendingSnapshot = Promise.withResolvers<{
            provider: 'codex';
            status: 'running';
            observedAt: number;
            available: true;
            sessionId: string;
        }>();
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() => pendingSnapshot.promise);
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
        );

        try {
            coordinator.probeTerminal(created.terminal!.id);
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
            coordinator.prepareTerminalStart(created.terminal!.id);
            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBeUndefined();

            pendingSnapshot.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'old-agent-session',
            });
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBeUndefined();
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('probes Agent Terminal output, ignores Shell output, and stops after a Terminal is closed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-coordinator-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const shell = database.createTerminal(created.session.id, 'shell');
        const events: ServerEvent[] = [];
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: `session-for-${context.rootPath.length}`,
                title: 'Repair terminal lifecycle',
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            (event) => {
                events.push(event);
            },
            createLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.observeOutput(shell.id);
            coordinator.observeOutput(created.terminal!.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(1);
            /**
             * The first Agent Terminal owns the Session title, so its metadata reaches the Renderer.
             */
            expect(events).toEqual([
                {
                    event: 'state.changed',
                    payload: {
                        kind: 'records',
                        sessionIds: [created.session.id],
                        terminalIds: [created.terminal!.id],
                    },
                },
            ]);
            expect(database.getSession(created.session.id)?.title).toBe(
                'Repair terminal lifecycle',
            );

            coordinator.observeOutput(created.terminal!.id);
            coordinator.forgetTerminal(created.terminal!.id);
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(snapshot).toHaveBeenCalledTimes(1);

            database.closeTerminal(created.terminal!.id);
            coordinator.observeOutput(created.terminal!.id);
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(snapshot).toHaveBeenCalledTimes(1);
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('publishes one unread generation for each reliable Claude attention transition', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-attention-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const createdActivityAt = created.session.sessionActivityAt;
        let status: 'running' | 'waiting' = 'waiting';
        const firstSnapshot = Promise.withResolvers<void>();
        let snapshotGate: PromiseWithResolvers<void> | undefined = firstSnapshot;
        const snapshot = vi.fn<AgentAdapter['snapshot']>(async () => {
            const observedStatus = status;
            const gate = snapshotGate;
            snapshotGate = undefined;
            if (gate) await gate.promise;
            return {
                provider: 'claude',
                ...(observedStatus === 'waiting' && { attentionKind: 'waiting' as const }),
                status: observedStatus,
                observedAt: Date.now(),
                available: true,
                sessionId: 'claude-session',
            };
        });
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.probeTerminal(created.terminal!.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(1);
            coordinator.probeTerminal(created.terminal!.id);
            firstSnapshot.resolve();
            await expect.poll(() => snapshot.mock.calls.length).toBe(2);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                sessionActivityAt: createdActivityAt,
                sessionActivityReason: 'created',
            });
            status = 'running';
            coordinator.observeOutput(created.terminal!.id);
            await expect
                .poll(() => database.getSession(created.session.id)?.sessionActivityReason)
                .toBe('agent_started');

            const transitionSnapshot = Promise.withResolvers<void>();
            snapshotGate = transitionSnapshot;
            coordinator.observeOutput(created.terminal!.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(4);
            status = 'waiting';
            coordinator.probeTerminal(created.terminal!.id);
            transitionSnapshot.resolve();
            await expect
                .poll(() => database.getSession(created.session.id)?.attentionGeneration)
                .toBe(1);
            expect(database.getSession(created.session.id)).toMatchObject({
                lastAttentionKind: 'waiting',
                hasUnread: true,
                sessionActivityReason: 'agent_waiting',
            });
            const waitingActivityAt = database.getSession(created.session.id)!.sessionActivityAt;
            expect(waitingActivityAt).toBeGreaterThan(createdActivityAt);

            coordinator.observeOutput(created.terminal!.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(6);
            expect(database.getSession(created.session.id)?.attentionGeneration).toBe(1);
            expect(database.getSession(created.session.id)?.sessionActivityAt).toBe(
                waitingActivityAt,
            );
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('keeps a validated Codex hook completion authoritative over later metadata probes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-attention-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                attentionKind: 'waiting',
                status: 'waiting',
                observedAt: Date.now(),
                available: true,
                sessionId: 'codex-session',
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });

            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 1,
                agentActivityState: 'completed',
                lastAttentionKind: 'completed',
            });

            coordinator.observeOutput(created.terminal!.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(1);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 1,
                agentActivityState: 'completed',
                lastAttentionKind: 'completed',
            });
            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBe(
                'codex-session',
            );

            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            expect(database.getSession(created.session.id)?.attentionGeneration).toBe(1);
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('keeps metadata attention available until a hook delivers attention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-fallback-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                attentionKind: 'completed',
                status: 'completed',
                observedAt: Date.now(),
                available: true,
                sessionId: 'claude-session',
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId: created.terminal!.id,
            });
            coordinator.observeOutput(created.terminal!.id);

            await expect
                .poll(() => database.getSession(created.session.id)?.attentionGeneration)
                .toBe(1);
            expect(database.getSession(created.session.id)).toMatchObject({
                hasUnread: true,
                agentActivityState: 'completed',
                lastAttentionKind: 'completed',
            });
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('restores metadata attention fallback at the start of every later turn', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-next-turn-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                attentionKind: 'completed',
                status: 'completed',
                observedAt: Date.now(),
                available: true,
                sessionId: 'codex-session',
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            expect(database.getSession(created.session.id)?.attentionGeneration).toBe(1);

            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            coordinator.observeOutput(created.terminal!.id);

            await expect
                .poll(() => database.getSession(created.session.id)?.attentionGeneration)
                .toBe(2);
            expect(database.getSession(created.session.id)).toMatchObject({
                hasUnread: true,
                agentActivityState: 'completed',
                lastAttentionKind: 'completed',
            });
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('does not let a lifecycle signal promote an unverified Shell Terminal', async () => {
        const directory = join(tmpdir(), `caxri-agent-hook-shell-${randomUUID()}`);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(() => Promise.reject(new Error('not used'))),
            () => {},
            createLogger(join(directory, 'logs')),
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');

            expect(
                coordinator.observeLifecycleSignal({
                    launchId: 'launch-1',
                    phase: 'turnFinished',
                    provider: 'codex',
                    terminalId: created.terminal!.id,
                }),
            ).toBe('providerMismatch');
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                kind: 'shell',
                provider: undefined,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
            });
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('probes the Session primary Agent Terminal and survives a failing probe', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-primary-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.reject(new Error('probe exploded')),
        );
        const logger = createLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            logger,
        );

        try {
            coordinator.probeSessionPrimaryAgent(created.session.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(1);
            expect(database.getSession(created.session.id)?.title).toBe('Untitled');

            const shellOnly = database.createSession(
                database.createProject(join(directory, 'other')).id,
                'shell',
            );
            coordinator.probeSessionPrimaryAgent(shellOnly.session.id);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(snapshot).toHaveBeenCalledTimes(1);
        } finally {
            await coordinator.close();
            database.close();
        }
    });
});
