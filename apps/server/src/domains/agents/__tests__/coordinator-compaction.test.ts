import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

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

describe('AgentCoordinator compaction', () => {
    it('tracks a transient Terminal operation without changing Session attention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-compaction-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const events: ServerEvent[] = [];
        const coordinator = new AgentCoordinator(
            database,
            createAgents(() => Promise.reject(new Error('not used'))),
            (event) => events.push(event),
            new StructuredLogger(join(directory, 'logs')),
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            const activityBeforeCompaction = database.getSession(created.session.id);

            expect(
                coordinator.observeLifecycleSignal({
                    launchId: 'launch-1',
                    phase: 'compactionStarted',
                    provider: 'codex',
                    terminalId: created.terminal!.id,
                }),
            ).toBe(true);
            expect(coordinator.agentOperation(created.terminal!.id)).toBe('compacting');
            expect(database.getSession(created.session.id)).toEqual(activityBeforeCompaction);
            expect(events.at(-1)).toEqual({
                event: 'state.changed',
                payload: {
                    kind: 'records',
                    sessionIds: [created.session.id],
                    terminalIds: [created.terminal!.id],
                },
            });

            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'compactionFinished',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            expect(coordinator.agentOperation(created.terminal!.id)).toBeUndefined();
            expect(database.getSession(created.session.id)).toEqual(activityBeforeCompaction);

            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'compactionStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            coordinator.endTerminalLaunch(created.terminal!.id);
            expect(coordinator.agentOperation(created.terminal!.id)).toBeUndefined();
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('clears compaction when the matching completion hook is lost', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-compaction-timeout-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(() => Promise.reject(new Error('not used'))),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            { compactionTimeoutMs: 5 },
        );

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'compactionStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            expect(coordinator.agentOperation(created.terminal!.id)).toBe('compacting');
            await expect
                .poll(() => coordinator.agentOperation(created.terminal!.id))
                .toBeUndefined();
        } finally {
            coordinator.close();
            database.close();
        }
    });

    it('clears compaction only for a standalone Escape input payload', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-compaction-escape-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const events: ServerEvent[] = [];
        const coordinator = new AgentCoordinator(
            database,
            createAgents(() => Promise.reject(new Error('not used'))),
            (event) => events.push(event),
            new StructuredLogger(join(directory, 'logs')),
        );
        const startCompaction = () => {
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'compactionStarted',
                provider: 'codex',
                terminalId: created.terminal!.id,
            });
            events.length = 0;
        };

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            startCompaction();

            coordinator.observeInput(created.terminal!.id, '\u{1B}');

            expect(coordinator.agentOperation(created.terminal!.id)).toBeUndefined();
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

            startCompaction();
            coordinator.observeInput(created.terminal!.id, '\u{1B}\r');
            expect(coordinator.agentOperation(created.terminal!.id)).toBe('compacting');
            expect(events).toEqual([]);

            coordinator.observeInput(created.terminal!.id, '\u{1B}[A');
            expect(coordinator.agentOperation(created.terminal!.id)).toBe('compacting');
            expect(events).toEqual([]);
        } finally {
            coordinator.close();
            database.close();
        }
    });
});
