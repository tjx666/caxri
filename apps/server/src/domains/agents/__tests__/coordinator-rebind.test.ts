import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAgentService } from '../../__tests__/create-test-domain-services';
import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';

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

function createAgents(snapshot: AgentAdapter['snapshot']) {
    return createTestAgentService({
        claude: { provider: 'claude', snapshot },
        codex: { provider: 'codex', snapshot },
    });
}

afterEach(async () => {
    await flushLoggers();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A manual in-terminal resume never passes through Caxri's launch reset. Exact lifecycle identity and the narrow
 * unbound process fallback must both respect current Terminal ownership.
 */
describe('AgentCoordinator session rebinding', () => {
    it.each([false, true])(
        'holds an early Shell turn behind foreground confirmation (retired: %s)',
        async (retired) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-hook-confirmation-'));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'shell');
            const terminalId = created.terminal!.id;
            database.updateTerminalState(terminalId, 'running');
            const confirmation = Promise.withResolvers<'codex'>();
            const logger = createLogger(join(directory, 'logs'));
            const coordinator = new AgentCoordinator(
                database,
                createAgents(() =>
                    Promise.resolve({
                        provider: 'codex',
                        status: 'unknown',
                        sessionId: 'unrelated-metadata-thread',
                        available: true,
                        observedAt: Date.now(),
                    }),
                ),
                () => {},
                logger,
                {
                    detectForegroundAgent: () => confirmation.promise,
                    refreshDelayMs: 60_000,
                },
            );
            try {
                coordinator.beginTerminalLaunch(terminalId, 'shell-launch');
                coordinator.observeInput(terminalId, 'codex resume resumed-thread\r');
                coordinator.observeOutput(terminalId, 123);
                expect(
                    coordinator.observeLifecycleSignal({
                        terminalId,
                        launchId: 'shell-launch',
                        provider: 'codex',
                        phase: 'turnStarted',
                        agentSessionId: 'resumed-thread',
                    }),
                ).toBe('providerMismatch');
                await coordinator.probeTerminalNow(terminalId);
                expect(database.getTerminal(terminalId)?.provider).toBeUndefined();
                expect(database.getSession(created.session.id)?.lastActivityState).toBe('idle');
                if (retired) coordinator.endTerminalLaunch(terminalId);
                confirmation.resolve('codex');
                if (retired) {
                    await confirmation.promise;
                    await coordinator.probeTerminalNow(terminalId);
                    expect(database.getTerminal(terminalId)?.provider).toBeUndefined();
                } else {
                    await expect
                        .poll(() => database.getSession(created.session.id)?.lastActivityState)
                        .toBe('running');
                    expect(database.getTerminal(terminalId)?.agentSessionId).toBe('resumed-thread');
                }
            } finally {
                confirmation.resolve('codex');
                coordinator.close();
                database.close();
                await logger.flush();
            }
        },
    );

    it.each(['hook', 'exit'] as const)(
        'discards an open-file identity result after %s retires its authority',
        async (boundary) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-process-identity-race-'));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'codex');
            const terminalId = created.terminal!.id;
            database.updateTerminalState(terminalId, 'running');
            const gate = Promise.withResolvers<void>();
            const entered = Promise.withResolvers<void>();
            const snapshot = vi.fn<AgentAdapter['snapshot']>(async (context) => {
                if (context.shellPid !== undefined) {
                    entered.resolve();
                    await gate.promise;
                    return {
                        provider: 'codex',
                        status: 'unknown',
                        observedAt: Date.now(),
                        available: true,
                        sessionId: 'stale-process-thread',
                        title: 'Stale title',
                    };
                }
                return {
                    provider: 'codex',
                    status: 'unknown',
                    observedAt: Date.now(),
                    available: true,
                };
            });
            const logger = createLogger(join(directory, 'logs'));
            const coordinator = new AgentCoordinator(
                database,
                createAgents(snapshot),
                () => {},
                logger,
                { refreshDelayMs: 60_000 },
            );
            try {
                coordinator.beginTerminalLaunch(terminalId, 'launch-1');
                coordinator.observeOutput(terminalId, 123);
                const pending = coordinator.probeTerminalNow(terminalId);
                await entered.promise;
                if (boundary === 'hook') {
                    coordinator.observeLifecycleSignal({
                        agentSessionId: 'hook-thread',
                        launchId: 'launch-1',
                        phase: 'sessionIdentified',
                        provider: 'codex',
                        terminalId,
                    });
                } else {
                    coordinator.endTerminalLaunch(terminalId);
                }
                gate.resolve();
                await pending;
                expect(database.getTerminal(terminalId)?.agentSessionId).toBe(
                    boundary === 'hook' ? 'hook-thread' : undefined,
                );
            } finally {
                gate.resolve();
                coordinator.close();
                database.close();
                await logger.flush();
            }
        },
    );

    it('limits unbound process probes to one per thirty seconds and resets the budget on resume', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-process-identity-budget-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const terminalId = created.terminal!.id;
        database.updateTerminalState(terminalId, 'running');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'unknown',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const logger = createLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            logger,
            { refreshDelayMs: 60_000 },
        );
        let now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            coordinator.observeOutput(terminalId, 123);
            await coordinator.probeTerminalNow(terminalId);
            now += 5_000;
            await coordinator.probeTerminalNow(terminalId);
            now += 25_000;
            await coordinator.probeTerminalNow(terminalId);
            expect(snapshot.mock.calls.map(([context]) => context.shellPid)).toEqual([
                123,
                undefined,
                123,
            ]);
            coordinator.prepareTerminalResume(terminalId);
            coordinator.observeOutput(terminalId, 456);
            await coordinator.probeTerminalNow(terminalId);
            expect(snapshot.mock.lastCall?.[0].shellPid).toBe(456);
        } finally {
            clock.mockRestore();
            coordinator.close();
            database.close();
            await logger.flush();
        }
    });

    it('refreshes the title when SessionStart identifies an already-bound resumed thread', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-session-start-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        database.rebindAgentSession(created.terminal!.id, 'codex', 'session-resumed');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'session-resumed',
                title: 'Resumed Codex thread',
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
                agentSessionId: 'session-resumed',
                launchId: 'launch-1',
                phase: 'sessionIdentified',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });

            await expect
                .poll(() => database.getSession(created.session.id)?.displayTitle)
                .toBe('Resumed Codex thread');
            expect(database.getTerminal(created.terminal!.id)?.title).toBe('Resumed Codex thread');
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('rebinds a Terminal and republishes the title when a hook signal names a manually resumed session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-rebind-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                ...(context.agentSessionId === 'session-b'
                    ? { sessionId: 'session-b', title: 'Resumed session' }
                    : { sessionId: 'session-a', title: 'Original session' }),
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
            coordinator.observeOutput(created.terminal!.id);
            await expect
                .poll(() => database.getTerminal(created.terminal!.id)?.agentSessionId)
                .toBe('session-a');
            expect(database.getSession(created.session.id)?.displayTitle).toBe('Original session');

            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                agentSessionId: 'session-b',
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId: created.terminal!.id,
            });

            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBe('session-b');
            await expect
                .poll(() => database.getSession(created.session.id)?.displayTitle)
                .toBe('Resumed session');
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('ignores a stale in-flight probe that resolves after a hook rebind', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-rebind-race-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const staleProbeGate = Promise.withResolvers<void>();
        const snapshot = vi.fn<AgentAdapter['snapshot']>(async (context) => {
            if (context.agentSessionId === 'session-b') {
                return {
                    provider: 'claude',
                    status: 'running',
                    observedAt: Date.now(),
                    available: true,
                    sessionId: 'session-b',
                    title: 'Resumed session',
                };
            }
            // The pre-rebind probe parks here so its stale result lands only after the rebind.
            await staleProbeGate.promise;
            return {
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'session-a',
                title: 'Original session',
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
            coordinator.observeOutput(created.terminal!.id);
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());

            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                agentSessionId: 'session-b',
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId: created.terminal!.id,
            });
            staleProbeGate.resolve();

            await expect
                .poll(() => database.getSession(created.session.id)?.displayTitle)
                .toBe('Resumed session');
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBe('session-b');
            expect(database.getSession(created.session.id)?.displayTitle).toBe('Resumed session');
        } finally {
            staleProbeGate.resolve();
            coordinator.close();
            database.close();
        }
    });

    it('rebinds from an exact hook identity even when another Terminal shows the same Agent session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-rebind-claimed-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const projectId = database.createProject(directory).id;
        const created = database.createSession(projectId, 'claude');
        const sibling = database.createSession(projectId, 'claude');
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                ...(context.agentSessionId === 'session-claimed' && {
                    sessionId: 'session-claimed',
                    title: 'Shared resumed session',
                }),
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
            database.rebindAgentSession(sibling.terminal!.id, 'claude', 'session-claimed');
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                agentSessionId: 'session-claimed',
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId: created.terminal!.id,
            });

            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBe(
                'session-claimed',
            );
            expect(database.getTerminal(sibling.terminal!.id)?.agentSessionId).toBe(
                'session-claimed',
            );
            await expect
                .poll(() => database.getSession(created.session.id)?.displayTitle)
                .toBe('Shared resumed session');
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
