import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../../shared/ipc';
import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../database';
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
