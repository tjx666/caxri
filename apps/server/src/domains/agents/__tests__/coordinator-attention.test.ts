import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

const temporaryDirectories: string[] = [];

function createAgents(): AgentService {
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const snapshot: AgentAdapter['snapshot'] = () => Promise.reject(new Error('not used'));
    const adapters: Record<AgentProvider, AgentAdapter> = {
        claude: { provider: 'claude', renameSession, snapshot },
        codex: { provider: 'codex', renameSession, snapshot },
    };
    return new AgentService(undefined, adapters);
}

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('AgentCoordinator permission attention', () => {
    it('resumes Claude only after every permission-requesting Agent scope finishes its batch', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-permission-resolution-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
        );
        const baseSignal = {
            launchId: 'launch-1',
            provider: 'claude' as const,
            terminalId: created.terminal!.id,
        };

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, baseSignal.launchId);
            coordinator.observeLifecycleSignal({ ...baseSignal, phase: 'turnStarted' });
            coordinator.observeLifecycleSignal({
                ...baseSignal,
                phase: 'attentionRequested',
            });
            coordinator.observeLifecycleSignal({
                ...baseSignal,
                agentId: 'subagent-1',
                phase: 'attentionRequested',
            });

            expect(database.getSession(created.session.id)).toMatchObject({
                attentionEpoch: 1,
                lastActivityState: 'waiting',
            });

            coordinator.observeLifecycleSignal({
                ...baseSignal,
                agentId: 'unrelated-subagent',
                phase: 'toolBatchFinished',
            });
            coordinator.observeLifecycleSignal({
                ...baseSignal,
                phase: 'toolBatchFinished',
            });
            expect(database.getSession(created.session.id)?.lastActivityState).toBe('waiting');

            coordinator.observeLifecycleSignal({
                ...baseSignal,
                agentId: 'subagent-1',
                phase: 'toolBatchFinished',
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionEpoch: 1,
                lastActivityState: 'running',
            });

            coordinator.observeLifecycleSignal({
                ...baseSignal,
                agentId: 'subagent-1',
                phase: 'toolBatchFinished',
            });
            expect(database.getSession(created.session.id)?.lastActivityState).toBe('running');
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
