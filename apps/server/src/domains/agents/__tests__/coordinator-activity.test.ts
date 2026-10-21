import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
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

afterEach(async () => {
    await flushLoggers();
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

describe('AgentCoordinator Session Activity', () => {
    it('accepts a running latest turn as evidence after an explicit Terminal resume', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-resume-activity-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        database.rebindAgentSession(created.terminal!.id, 'codex', 'resumed-thread');
        const snapshot: AgentAdapter['snapshot'] = () =>
            Promise.resolve({
                activitySource: 'latestTurn',
                activityTurnId: 'resumed-turn',
                available: true,
                observedAt: Date.now(),
                provider: 'codex',
                sessionId: 'resumed-thread',
                status: 'running',
            });
        const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
        const adapters: Record<AgentProvider, AgentAdapter> = {
            claude: { provider: 'claude', renameSession, snapshot },
            codex: { provider: 'codex', renameSession, snapshot },
            grok: { provider: 'grok', renameSession, snapshot },
        };
        const coordinator = new AgentCoordinator(
            database,
            new AgentService(undefined, adapters),
            () => {},
            createLogger(join(directory, 'logs')),
        );

        try {
            coordinator.prepareTerminalResume(created.terminal!.id);
            await coordinator.probeTerminalNow(created.terminal!.id);
            expect(database.getSession(created.session.id)?.lastActivityState).toBe('running');
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('does not derive Session activity from a process-only baseline probe', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-process-baseline-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const idle = database.createSession(project.id, 'codex');
        const completed = database.createSession(project.id, 'codex');
        const staleRunning = database.createSession(project.id, 'codex');
        database.updateAgentLifecycle({
            launchId: 'completed-launch',
            phase: 'turnFinished',
            provider: 'codex',
            terminalId: completed.terminal!.id,
        });
        database.database
            .prepare('UPDATE terminals SET last_process_state = ? WHERE id IN (?, ?, ?)')
            .run('running', idle.terminal!.id, completed.terminal!.id, staleRunning.terminal!.id);
        database.database
            .prepare('UPDATE sessions SET last_activity_state = ? WHERE id = ?')
            .run('running', staleRunning.session.id);
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'unknown',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
        const adapters: Record<AgentProvider, AgentAdapter> = {
            claude: { provider: 'claude', renameSession, snapshot },
            codex: { provider: 'codex', renameSession, snapshot },
            grok: { provider: 'grok', renameSession, snapshot },
        };
        const coordinator = new AgentCoordinator(
            database,
            new AgentService(undefined, adapters),
            () => {},
            createLogger(join(directory, 'logs')),
        );

        try {
            coordinator.probeTerminal(idle.terminal!.id);
            coordinator.probeTerminal(completed.terminal!.id);
            coordinator.probeTerminal(staleRunning.terminal!.id);
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
            expect(database.getSession(idle.session.id)).toMatchObject({
                lastActivityState: 'idle',
                lastSessionActivityReason: 'created',
            });
            expect(database.getSession(completed.session.id)).toMatchObject({
                lastActivityState: 'completed',
                lastSessionActivityReason: 'agent_completed',
            });
            expect(database.getSession(staleRunning.session.id)).toMatchObject({
                lastActivityState: 'unknown',
                lastSessionActivityReason: 'created',
            });
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('distinguishes a stale Codex running baseline from reliable and newer activity', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-running-baseline-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const session = database.createSession(project.id, 'codex');
        const claudeSession = database.createSession(project.id, 'claude');
        database.updateAgentLifecycle({
            launchId: 'completed-launch',
            phase: 'turnFinished',
            provider: 'codex',
            terminalId: session.terminal!.id,
        });
        const snapshot = vi
            .fn<AgentAdapter['snapshot']>()
            .mockImplementationOnce(() =>
                Promise.resolve({
                    provider: 'codex',
                    activitySource: 'latestTurn',
                    activityTurnId: 'stale-turn',
                    status: 'running',
                    observedAt: Date.now(),
                    available: true,
                }),
            )
            .mockImplementationOnce(() =>
                Promise.resolve({
                    provider: 'codex',
                    activitySource: 'latestTurn',
                    activityTurnId: 'new-turn',
                    status: 'running',
                    observedAt: Date.now(),
                    available: true,
                }),
            );
        const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
        const claudeSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'running',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const adapters: Record<AgentProvider, AgentAdapter> = {
            claude: { provider: 'claude', renameSession, snapshot: claudeSnapshot },
            codex: { provider: 'codex', renameSession, snapshot },
            grok: { provider: 'grok', renameSession, snapshot },
        };
        const coordinator = new AgentCoordinator(
            database,
            new AgentService(undefined, adapters),
            () => {},
            createLogger(join(directory, 'logs')),
        );

        try {
            coordinator.probeTerminal(session.terminal!.id);
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
            expect(database.getSession(session.session.id)).toMatchObject({
                lastActivityState: 'completed',
                lastSessionActivityReason: 'agent_completed',
            });
            coordinator.probeTerminal(session.terminal!.id);
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
            expect(database.getSession(session.session.id)).toMatchObject({
                lastActivityState: 'running',
                lastSessionActivityReason: 'agent_started',
            });
            coordinator.probeTerminal(claudeSession.terminal!.id);
            await vi.waitFor(() => expect(claudeSnapshot).toHaveBeenCalledOnce());
            expect(database.getSession(claudeSession.session.id)).toMatchObject({
                lastActivityState: 'running',
                lastSessionActivityReason: 'created',
            });
        } finally {
            await coordinator.close();
            database.close();
        }
    });
});
