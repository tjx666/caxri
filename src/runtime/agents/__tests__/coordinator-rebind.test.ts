import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

const temporaryDirectories: string[] = [];

function createAgents(snapshot: AgentAdapter['snapshot']): AgentService {
    return new AgentService(undefined, {
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
 * A manual in-terminal resume never passes through Caxri's launch reset, so the hook-carried session identifier is the
 * only rebind path (issue #199).
 */
describe('AgentCoordinator session rebinding', () => {
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
            new StructuredLogger(join(directory, 'logs')),
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

    it('does not rebind to an Agent session another Terminal of the same provider owns', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-rebind-claimed-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const projectId = database.createProject(directory).id;
        const created = database.createSession(projectId, 'claude');
        const sibling = database.createSession(projectId, 'claude');
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

            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBeUndefined();
            expect(database.getTerminal(sibling.terminal!.id)?.agentSessionId).toBe(
                'session-claimed',
            );
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
