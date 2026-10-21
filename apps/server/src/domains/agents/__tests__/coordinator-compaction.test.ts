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
            createLogger(join(directory, 'logs')),
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
            ).toBe('accepted');
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
            await coordinator.close();
            database.close();
        }
    });

    it('keeps a keep-alive compaction turn out of Session state but shows the next turn', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-maintenance-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(() => Promise.reject(new Error('not used'))),
            () => {},
            createLogger(join(directory, 'logs')),
        );
        const terminalId = created.terminal!.id;
        const signal = (
            phase: 'compactionFinished' | 'compactionStarted' | 'turnFinished' | 'turnStarted',
        ) =>
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase,
                provider: 'codex',
                terminalId,
            });

        try {
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            const before = database.getSession(created.session.id);
            coordinator.maintenanceTurns.begin(terminalId);
            expect(signal('turnStarted')).toBe('maintenanceTurn');
            expect(signal('compactionStarted')).toBe('maintenanceTurn');
            expect(coordinator.agentOperation(terminalId)).toBeUndefined();
            expect(database.getSession(created.session.id)).toEqual(before);
            expect(signal('compactionFinished')).toBe('maintenanceTurn');
            expect(signal('turnFinished')).toBe('maintenanceTurn');
            expect(database.getSession(created.session.id)).toEqual(before);

            expect(signal('turnStarted')).toBe('accepted');
            expect(database.getSession(created.session.id)!.lastActivityState).toBe('running');
        } finally {
            await coordinator.close();
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
            createLogger(join(directory, 'logs')),
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
            await coordinator.close();
            database.close();
        }
    });

    it.each(['escape', 'control'] as const)(
        'clears compaction through %s but not editing sequences',
        async (entry) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-compaction-escape-'));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'codex');
            const events: ServerEvent[] = [];
            const coordinator = new AgentCoordinator(
                database,
                createAgents(() => Promise.reject(new Error('not used'))),
                (event) => events.push(event),
                createLogger(join(directory, 'logs')),
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

                if (entry === 'escape') coordinator.observeInput(created.terminal!.id, '\u{1B}');
                else coordinator.observeInterrupt(created.terminal!.id, 'launch-1');

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
                await coordinator.close();
                database.close();
            }
        },
    );
});
