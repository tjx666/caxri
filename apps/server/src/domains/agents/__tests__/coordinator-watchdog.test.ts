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
    return createTestAgentService({ codex: { provider: 'codex', snapshot } });
}

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('AgentCoordinator running watchdog', () => {
    it('reconciles a completed Codex turn when the Stop hook is lost', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-running-watchdog-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
            Promise.resolve({
                provider: 'codex',
                attentionKind: context.agentTurnId ? ('completed' as const) : undefined,
                status: context.agentTurnId ? ('completed' as const) : ('running' as const),
                observedAt: Date.now(),
                available: true,
                sessionId: context.agentSessionId,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { refreshDelayMs: 5, runningWatchdogIntervalMs: 5 },
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                agentSessionId: 'codex-session-1',
                agentTurnId: 'codex-turn-1',
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });

            await expect
                .poll(() => database.getSession(created.session.id)?.lastActivityState)
                .toBe('completed');
            expect(snapshot).toHaveBeenCalledWith(
                expect.objectContaining({
                    agentSessionId: 'codex-session-1',
                    agentTurnId: 'codex-turn-1',
                }),
            );
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'completed',
            });

            coordinator.observeOutput(created.terminal!.id);
            await expect.poll(() => snapshot.mock.calls.length).toBe(2);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionEpoch: 1,
                lastActivityState: 'completed',
                lastAttentionKind: 'completed',
            });
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('keeps checking a long-running turn and stops after a real completion hook', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-running-watchdog-live-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'codex-session-1',
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { runningWatchdogIntervalMs: 5 },
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                agentSessionId: 'codex-session-1',
                agentTurnId: 'codex-turn-1',
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            await expect.poll(() => snapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(database.getSession(created.session.id)?.lastActivityState).toBe('running');

            coordinator.observeLifecycleSignal({
                agentTurnId: 'codex-turn-1',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            const completedProbeCount = snapshot.mock.calls.length;
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(snapshot).toHaveBeenCalledTimes(completedProbeCount);
            expect(database.getSession(created.session.id)?.lastActivityState).toBe('completed');
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
