import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { createTestAgentService } from '../../__tests__/create-test-runtime';
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
            ).toBe(false);
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
