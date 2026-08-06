import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../../shared/ipc';
import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import { AgentService, type AgentAdapter } from '../service';

const temporaryDirectories: string[] = [];

function createAgents(snapshot: AgentAdapter['snapshot']): AgentService {
    return new AgentService(undefined, {
        claude: { provider: 'claude', snapshot },
        codex: { provider: 'codex', snapshot },
    });
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('AgentCoordinator', () => {
    it.each(['claude', 'codex'] as const)(
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
                    ...(context.startedAt ? {} : { sessionId: undefined }),
                }),
            );
            const coordinator = new AgentCoordinator(
                database,
                createAgents(snapshot),
                () => undefined,
                new StructuredLogger(join(directory, 'logs')),
                { refreshDelayMs: 5 },
            );

            try {
                coordinator.observeInput(created.terminal.id, `echo ${provider}\r`);
                coordinator.observeOutput(created.terminal.id);
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(snapshot).not.toHaveBeenCalled();

                coordinator.observeInput(created.terminal.id, `${provider}\r`);
                coordinator.observeOutput(created.terminal.id);

                await expect
                    .poll(() => database.getTerminal(created.terminal.id)?.provider)
                    .toBe(provider);
                expect(database.getTerminal(created.terminal.id)).toMatchObject({
                    agentSessionId: `${provider}-session`,
                    icon: provider,
                    kind: provider,
                    title: provider === 'claude' ? 'Claude Code' : 'Codex',
                });
                expect(database.getSession(created.session.id)).toMatchObject({
                    displayTitle: `${provider} from Shell`,
                    primaryAgentTerminalId: created.terminal.id,
                });
            } finally {
                coordinator.close();
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
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal.id, 'cxy\r');
            coordinator.observeOutput(created.terminal.id, 4242);

            await expect
                .poll(() => database.getTerminal(created.terminal.id)?.provider)
                .toBe('codex');
            expect(detectForegroundAgent).toHaveBeenCalledWith(4242);
            expect(database.getTerminal(created.terminal.id)).toMatchObject({
                agentSessionId: undefined,
                icon: 'codex',
                kind: 'codex',
                title: 'Codex',
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                displayTitle: 'Codex',
                primaryAgentTerminalId: created.terminal.id,
            });
        } finally {
            coordinator.close();
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
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5 },
        );
        /** Fake only Date so the probe-interval clock advances without touching real timers. */
        vi.useFakeTimers({ toFake: ['Date'] });

        try {
            coordinator.observeInput(created.terminal.id, 'tail -f dev.log\r');
            // Simulate a long-lived command emitting output far past the probe budget.
            for (let round = 0; round < 10; round += 1) {
                for (let chunk = 0; chunk < 20; chunk += 1)
                    coordinator.observeOutput(created.terminal.id, 4242);
                await new Promise((resolve) => setTimeout(resolve, 5));
                vi.setSystemTime(Date.now() + 2_100);
            }
            expect(detectForegroundAgent.mock.calls.length).toBeLessThanOrEqual(5);
            expect(snapshot).not.toHaveBeenCalled();
            expect(database.getTerminal(created.terminal.id)?.provider).toBeUndefined();
        } finally {
            vi.useRealTimers();
            coordinator.close();
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
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.observeInput(created.terminal.id, 'claude\r');
            await expect.poll(() => snapshot.mock.calls.length).toBe(3);
            expect(database.getTerminal(created.terminal.id)).toMatchObject({
                agentSessionId: undefined,
                kind: 'shell',
                provider: undefined,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                displayTitle: 'Shell',
                primaryAgentTerminalId: undefined,
            });
        } finally {
            coordinator.close();
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
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.prepareTerminalStart(created.terminal.id);
            coordinator.prepareTerminalStart(second.id);
            coordinator.probeTerminal(created.terminal.id);
            coordinator.probeTerminal(second.id);

            await expect
                .poll(() =>
                    [created.terminal.id, second.id]
                        .map((id) => database.getTerminal(id)?.agentSessionId)
                        .filter(Boolean)
                        .sort(),
                )
                .toEqual(['agent-session-1', 'agent-session-2']);
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('excludes the previous Agent session when a Terminal restarts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-restart-correlation-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        database.updateAgentMetadata(created.terminal.id, {
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
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
        );

        try {
            coordinator.prepareTerminalStart(created.terminal.id);
            coordinator.probeTerminal(created.terminal.id);
            await expect
                .poll(() => database.getTerminal(created.terminal.id)?.agentSessionId)
                .toBe('new-agent-session');
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('probes Agent Terminal output, ignores Shell output, and stops after a Terminal is closed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-coordinator-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const shell = database.createTerminal(created.session.id, 'shell');
        const events: RuntimeEvent[] = [];
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
            (event) => events.push(event),
            new StructuredLogger(join(directory, 'logs')),
            { refreshDelayMs: 5 },
        );

        try {
            coordinator.observeOutput(shell.id);
            coordinator.observeOutput(created.terminal.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(1);
            /** The first Agent Terminal owns the Session title, so its metadata reaches the Renderer. */
            expect(events).toEqual([
                { event: 'state.changed', payload: { reason: 'agent.metadata' } },
            ]);
            expect(database.getSession(created.session.id)?.displayTitle).toBe(
                'Repair terminal lifecycle',
            );

            coordinator.observeOutput(created.terminal.id);
            coordinator.forgetTerminal(created.terminal.id);
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(snapshot).toHaveBeenCalledTimes(1);

            database.closeTerminal(created.terminal.id);
            coordinator.observeOutput(created.terminal.id);
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(snapshot).toHaveBeenCalledTimes(1);
        } finally {
            coordinator.close();
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
        const logger = new StructuredLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => undefined,
            logger,
        );

        try {
            coordinator.probeSessionPrimaryAgent(created.session.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(1);
            expect(database.getSession(created.session.id)?.displayTitle).toBe('Codex');

            const shellOnly = database.createSession(
                database.createProject(join(directory, 'other')).id,
                'shell',
            );
            coordinator.probeSessionPrimaryAgent(shellOnly.session.id);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(snapshot).toHaveBeenCalledTimes(1);
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
