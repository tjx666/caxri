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

function createAgents(
    snapshot: AgentAdapter['snapshot'] = () => Promise.reject(new Error('not used')),
): AgentService {
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const adapters: Record<AgentProvider, AgentAdapter> = {
        claude: { provider: 'claude', renameSession, snapshot },
        codex: { provider: 'codex', renameSession, snapshot },
        grok: { provider: 'grok', renameSession, snapshot },
    };
    return new AgentService(undefined, adapters);
}

afterEach(async () => {
    await flushLoggers();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('AgentCoordinator permission attention', () => {
    it.each(['escape', 'signal'] as const)(
        'releases a pending question after %s and ignores its late answer',
        async (entry) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-question-interrupt-'));
            temporaryDirectories.push(directory);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'codex');
            const coordinator = new AgentCoordinator(
                database,
                createAgents(() =>
                    Promise.resolve({
                        available: true,
                        provider: 'codex',
                        observedAt: Date.now(),
                        status: 'unknown',
                    }),
                ),
                () => {},
                createLogger(join(directory, 'logs')),
            );
            const base = {
                launchId: 'launch-1',
                provider: 'codex' as const,
                terminalId: created.terminal!.id,
            };
            const state = () => database.getSession(created.session.id)?.lastActivityState;
            try {
                coordinator.beginTerminalLaunch(base.terminalId, base.launchId);
                await coordinator.probeTerminalNow(base.terminalId);
                coordinator.observeLifecycleSignal({ ...base, phase: 'turnStarted' });
                coordinator.observeLifecycleSignal({
                    ...base,
                    phase: 'attentionRequested',
                    agentToolUseId: 'question-1',
                });
                expect(state()).toBe('waiting');
                coordinator.observeInterrupt(base.terminalId, 'stale-launch');
                await coordinator.probeTerminalNow(base.terminalId);
                expect(state()).toBe('waiting');
                if (entry === 'escape') coordinator.observeInput(base.terminalId, '\u{1B}');
                else coordinator.observeInterrupt(base.terminalId, base.launchId);
                await coordinator.probeTerminalNow(base.terminalId);
                expect(state()).toBe('unknown');
                coordinator.observeLifecycleSignal({
                    ...base,
                    phase: 'attentionResolved',
                    agentToolUseId: 'question-1',
                });
                expect(state()).toBe('unknown');
            } finally {
                await coordinator.close();
                database.close();
            }
        },
    );

    it('reports a SIGINT for the current launch only, so suspension and Caxri Bot can clear their turn marker (#1819)', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-signal-interrupt-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const interrupted: string[] = [];
        const coordinator = new AgentCoordinator(
            database,
            createAgents(),
            () => {},
            createLogger(join(directory, 'logs')),
            { onSignalInterrupt: (terminalId) => interrupted.push(terminalId) },
        );
        try {
            const terminalId = created.terminal!.id;
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            coordinator.observeInterrupt(terminalId, 'stale-launch');
            coordinator.observeInput(terminalId, '\u{1B}');
            expect(interrupted).toEqual([]);

            coordinator.observeInterrupt(terminalId, 'launch-1');
            expect(interrupted).toEqual([terminalId]);
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('keeps Codex waiting until every exact question resolves without clearing an approval', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-question-resolution-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(),
            () => {},
            createLogger(join(directory, 'logs')),
        );
        const base = {
            launchId: 'launch-1',
            provider: 'codex' as const,
            terminalId: created.terminal!.id,
        };
        const state = () => database.getSession(created.session.id)?.lastActivityState;
        try {
            coordinator.beginTerminalLaunch(base.terminalId, base.launchId);
            coordinator.observeLifecycleSignal({ ...base, phase: 'turnStarted' });
            for (const agentToolUseId of ['question-1', 'question-2'])
                coordinator.observeLifecycleSignal({
                    ...base,
                    agentToolUseId,
                    phase: 'attentionRequested',
                });
            expect(state()).toBe('waiting');
            for (const agentToolUseId of ['unrelated', 'question-1', 'question-1']) {
                coordinator.observeLifecycleSignal({
                    ...base,
                    agentToolUseId,
                    phase: 'attentionResolved',
                });
                expect(state()).toBe('waiting');
            }
            coordinator.observeLifecycleSignal({ ...base, phase: 'shellToolFinished' });
            expect(state()).toBe('waiting');
            coordinator.observeLifecycleSignal({
                ...base,
                agentToolUseId: 'question-2',
                phase: 'attentionResolved',
            });
            expect(state()).toBe('running');
            coordinator.observeLifecycleSignal({ ...base, phase: 'attentionRequested' });
            coordinator.observeLifecycleSignal({
                ...base,
                agentToolUseId: 'question-3',
                phase: 'attentionRequested',
            });
            coordinator.observeLifecycleSignal({
                ...base,
                agentToolUseId: 'question-3',
                phase: 'attentionResolved',
            });
            expect(state()).toBe('waiting');
            coordinator.observeLifecycleSignal({ ...base, phase: 'turnFinished' });
            expect(state()).toBe('completed');
            coordinator.observeLifecycleSignal({
                ...base,
                agentToolUseId: 'question-3',
                phase: 'attentionResolved',
            });
            expect(state()).toBe('completed');
            coordinator.observeLifecycleSignal({ ...base, phase: 'turnStarted' });
            expect(state()).toBe('running');
        } finally {
            await coordinator.close();
            database.close();
        }
    });

    it('resumes Claude only after every permission-requesting Agent scope finishes its batch', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-permission-resolution-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(),
            () => {},
            createLogger(join(directory, 'logs')),
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
            await coordinator.close();
            database.close();
        }
    });
});
