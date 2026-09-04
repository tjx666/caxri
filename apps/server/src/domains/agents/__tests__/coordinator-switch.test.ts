import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAgentService } from '../../__tests__/create-test-domain-services';
import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';

const temporaryDirectories: string[] = [];

function createAgents(snapshot: AgentAdapter['snapshot']) {
    return createTestAgentService({
        claude: { provider: 'claude', snapshot },
        codex: { provider: 'codex', snapshot },
    });
}

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Exiting one agent and launching another inside the same PTY must move the durable Terminal identity
 * (kind/provider/title/icon) to the new provider, confirmed by the independent foreground-process probe.
 */
describe('AgentCoordinator provider switch', () => {
    it('switches a bound Agent Terminal after a direct different-provider command is confirmed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-switch-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const detectForegroundAgent = vi.fn(() => Promise.resolve('claude' as const));
        const claudeSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'claude-session',
                title: 'Claude took over',
            }),
        );
        const codexSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createTestAgentService({
                claude: { provider: 'claude', snapshot: claudeSnapshot },
                codex: { provider: 'codex', snapshot: codexSnapshot },
            }),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'claude\r');
            coordinator.observeOutput(created.terminal!.id, 4242);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.provider)
                .toBe('claude');
            expect(detectForegroundAgent).toHaveBeenCalledWith(4242);
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                icon: 'claude',
                kind: 'claude',
                title: 'Claude Code',
            });
            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.agentSessionId)
                .toBe('claude-session');
            expect(database.getSession(created.session.id)).toMatchObject({
                displayTitle: 'Claude took over',
                primaryAgentTerminalId: created.terminal!.id,
            });
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('switches after an alias-launched different provider is confirmed by the process probe', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-switch-alias-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const detectForegroundAgent = vi.fn(() => Promise.resolve('claude' as const));
        const coordinator = new AgentCoordinator(
            database,
            createTestAgentService({
                claude: {
                    provider: 'claude',
                    snapshot: () =>
                        Promise.resolve({
                            provider: 'claude',
                            status: 'running',
                            observedAt: Date.now(),
                            available: true,
                        }),
                },
                codex: {
                    provider: 'codex',
                    snapshot: () =>
                        Promise.resolve({
                            provider: 'codex',
                            status: 'running',
                            observedAt: Date.now(),
                            available: true,
                        }),
                },
            }),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            // The submitted command names neither provider, so only the process probe can identify the launch.
            coordinator.observeInput(created.terminal!.id, 'ccy --continue\r');
            coordinator.observeOutput(created.terminal!.id, 4242);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.provider)
                .toBe('claude');
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                icon: 'claude',
                kind: 'claude',
            });
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('switches through provider metadata when process inspection cannot identify the agent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-switch-metadata-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        // The process probe never recognizes the new agent (e.g. an unrecognized install shape).
        const detectForegroundAgent = vi.fn(() => Promise.resolve(undefined));
        const claudeSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'claude-metadata-session',
                title: 'Claude confirmed by metadata',
            }),
        );
        const codexSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createTestAgentService({
                claude: { provider: 'claude', snapshot: claudeSnapshot },
                codex: { provider: 'codex', snapshot: codexSnapshot },
            }),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'claude\r');
            coordinator.observeOutput(created.terminal!.id, 4242);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.provider)
                .toBe('claude');
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                agentSessionId: 'claude-metadata-session',
                icon: 'claude',
                kind: 'claude',
            });
            await expect
                .poll(() => database.getSession(created.session.id)?.displayTitle)
                .toBe('Claude confirmed by metadata');
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('keeps the bound provider while the foreground process still matches it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-switch-noop-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
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
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'claude\r');
            coordinator.observeOutput(created.terminal!.id, 4242);
            await vi.waitFor(() => expect(detectForegroundAgent).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                icon: 'codex',
                kind: 'codex',
                provider: 'codex',
                title: 'Codex',
            });
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it.each(['claude', 'cc'])(
        'reactivates a stopped same-provider Agent launched with %s',
        async (command) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-relaunch-'));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'claude');
            database.rebindAgentSession(created.terminal!.id, 'claude', 'existing-session');
            database.updateTerminalState(created.terminal!.id, 'running');
            database.updateAgentProcessState(created.terminal!.id, 'dead');
            const detectForegroundAgent = vi.fn(() => Promise.resolve('claude' as const));
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
                new StructuredLogger(join(directory, 'logs')),
                { detectForegroundAgent, refreshDelayMs: 5 },
            );

            try {
                coordinator.observeInput(created.terminal!.id, `${command}\r`);
                coordinator.observeOutput(created.terminal!.id, 4242);

                await expect
                    .poll(() => database.getTerminal(created.terminal!.id)?.lastAgentProcessState)
                    .toBe('running');
                expect(detectForegroundAgent).toHaveBeenCalledWith(4242);
                expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                    agentSessionId: 'existing-session',
                    icon: 'claude',
                    kind: 'claude',
                    provider: 'claude',
                });
            } finally {
                coordinator.close();
                database.close();
            }
        },
    );

    it.each(['starting', 'running'] as const)(
        'does not inspect a direct same-provider command while the managed Agent is %s',
        async (state) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-relaunch-live-'));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'claude');
            database.updateAgentProcessState(created.terminal!.id, state);
            const detectForegroundAgent = vi.fn(() => Promise.resolve('claude' as const));
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
                new StructuredLogger(join(directory, 'logs')),
                { detectForegroundAgent, refreshDelayMs: 5 },
            );

            try {
                coordinator.observeInput(created.terminal!.id, 'claude\r');
                coordinator.observeOutput(created.terminal!.id, 4242);
                await new Promise((resolve) => setTimeout(resolve, 20));

                expect(detectForegroundAgent).not.toHaveBeenCalled();
                expect(database.getTerminal(created.terminal!.id)?.lastAgentProcessState).toBe(
                    state,
                );
            } finally {
                coordinator.close();
                database.close();
            }
        },
    );

    it('retries foreground detection after the submitted alias produces output before its Agent starts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-relaunch-retry-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        database.updateTerminalState(created.terminal!.id, 'running');
        database.updateAgentProcessState(created.terminal!.id, 'stopped');
        const detectForegroundAgent = vi
            .fn<() => Promise<'claude' | undefined>>()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValue('claude');
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
            new StructuredLogger(join(directory, 'logs')),
            {
                detectForegroundAgent,
                refreshDelayMs: 5,
                shellProcessProbeIntervalMs: 5,
            },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'cc\r');
            coordinator.observeOutput(created.terminal!.id, 4242);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.lastAgentProcessState)
                .toBe('running');
            expect(detectForegroundAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('revokes same-provider availability after the manually launched Agent exits', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-relaunch-exit-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        database.updateTerminalState(created.terminal!.id, 'running');
        database.updateAgentProcessState(created.terminal!.id, 'stopped');
        const detectForegroundAgent = vi
            .fn<() => Promise<'claude' | undefined>>()
            .mockResolvedValueOnce('claude')
            .mockResolvedValue(undefined);
        const coordinator = new AgentCoordinator(
            database,
            createAgents(() =>
                Promise.resolve({
                    provider: 'claude',
                    status: 'running',
                    observedAt: Date.now(),
                    available: true,
                }),
            ),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                detectForegroundAgent,
                refreshDelayMs: 5,
                shellProcessProbeIntervalMs: 5,
            },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'claude\r');
            coordinator.observeOutput(created.terminal!.id, 4242);

            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.lastAgentProcessState)
                .toBe('running');
            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.lastAgentProcessState)
                .toBe('stopped');
            expect(detectForegroundAgent).toHaveBeenCalledTimes(3);
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('cannot revoke a managed resume with a late probe from the previous manual Agent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-relaunch-resume-race-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        database.updateTerminalState(created.terminal!.id, 'running');
        database.updateAgentProcessState(created.terminal!.id, 'stopped');
        const lateProbe = Promise.withResolvers<'claude' | undefined>();
        const detectForegroundAgent = vi
            .fn<() => Promise<'claude' | undefined>>()
            .mockResolvedValueOnce('claude')
            .mockImplementationOnce(() => lateProbe.promise)
            .mockResolvedValue(undefined);
        const coordinator = new AgentCoordinator(
            database,
            createAgents(() =>
                Promise.resolve({
                    provider: 'claude',
                    status: 'running',
                    observedAt: Date.now(),
                    available: true,
                }),
            ),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            {
                detectForegroundAgent,
                refreshDelayMs: 5,
                shellProcessProbeIntervalMs: 5,
            },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'claude\r');
            coordinator.observeOutput(created.terminal!.id, 4242);
            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.lastAgentProcessState)
                .toBe('running');
            await expect.poll(() => detectForegroundAgent.mock.calls.length).toBeGreaterThan(1);

            coordinator.prepareTerminalResume(created.terminal!.id);
            database.updateAgentProcessState(created.terminal!.id, 'running');
            lateProbe.resolve(undefined);
            await new Promise((resolve) => setTimeout(resolve, 30));

            expect(database.getTerminal(created.terminal!.id)?.lastAgentProcessState).toBe(
                'running',
            );
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('keeps an inactive Agent stopped when the foreground process is not an Agent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-relaunch-unconfirmed-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        database.updateAgentProcessState(created.terminal!.id, 'dead');
        const detectForegroundAgent = vi.fn(() => Promise.resolve(undefined));
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
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal!.id, 'ls\r');
            coordinator.observeOutput(created.terminal!.id, 4242);
            await vi.waitFor(() => expect(detectForegroundAgent).toHaveBeenCalledWith(4242));

            expect(database.getTerminal(created.terminal!.id)?.lastAgentProcessState).toBe('dead');
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('lets a cross-provider lifecycle signal open a switch candidate but never change identity directly', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-switch-hook-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const detectForegroundAgent = vi.fn(() => Promise.resolve('claude' as const));
        const claudeSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'claude-hook-session',
                title: 'Claude hook launch',
            }),
        );
        const codexSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createTestAgentService({
                claude: { provider: 'claude', snapshot: claudeSnapshot },
                codex: { provider: 'codex', snapshot: codexSnapshot },
            }),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            expect(
                coordinator.observeLifecycleSignal({
                    agentSessionId: 'claude-hook-session',
                    launchId: 'launch-1',
                    phase: 'turnStarted',
                    provider: 'claude',
                    terminalId: created.terminal!.id,
                }),
            ).toBe('providerMismatch');
            /**
             * The signal alone must not rebind identity; only the foreground-process probe may.
             */
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                kind: 'codex',
                provider: 'codex',
            });

            coordinator.observeOutput(created.terminal!.id, 4242);
            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.provider)
                .toBe('claude');
            /**
             * A hook-opened candidate starts after the new provider session, so the confirmed switch must adopt the
             * hook-carried session identity immediately instead of waiting for a later same-provider signal.
             */
            expect(database.getTerminal(created.terminal!.id)).toMatchObject({
                agentSessionId: 'claude-hook-session',
                icon: 'claude',
                kind: 'claude',
                title: 'Claude Code',
            });
            await expect
                .poll(() => database.getSession(created.session.id)?.displayTitle)
                .toBe('Claude hook launch');
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
