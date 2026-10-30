import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentLifecycleSignal } from '../hooks/contract';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

function createAgents(
    snapshot: AgentAdapter['snapshot'] = () => Promise.reject(new Error('not used')),
): AgentService {
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const adapters: Record<AgentProvider, AgentAdapter> = {
        claude: { provider: 'claude', renameSession, snapshot },
        codex: { provider: 'codex', renameSession, snapshot },
        grok: { provider: 'grok', renameSession, snapshot },
        antigravity: { provider: 'antigravity', renameSession, snapshot },
    };
    return new AgentService(undefined, adapters);
}

describe('AgentCoordinator subagent lifecycle', () => {
    it('actively demotes a quiet hook turn only after repeated unknown evidence and two minutes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-hook-unknown-recovery-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                available: true,
                observedAt: Date.now(),
                provider: 'claude',
                status: 'unknown',
            }),
        );
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            logger,
        );
        const terminalId = created.terminal!.id;
        try {
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            await coordinator.probeTerminalNow(terminalId);
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId,
            });
            await coordinator.probeTerminalNow(terminalId);
            await coordinator.probeTerminalNow(terminalId);
            await coordinator.probeTerminalNow(terminalId);
            await vi.advanceTimersByTimeAsync(119_999);
            expect(database.getSession(created.session.id)?.agentActivityState).toBe('running');
            await vi.advanceTimersByTimeAsync(1);
            expect(database.getSession(created.session.id)).toMatchObject({
                agentActivityState: 'unknown',
                attentionGeneration: 0,
            });
        } finally {
            await coordinator.close();
            vi.useRealTimers();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('ignores a Claude subagent completion for Session activity and attention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-subagent-finished-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(database, createAgents(), () => {}, logger);

        try {
            coordinator.beginTerminalLaunch(created.terminal!.id, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId: created.terminal!.id,
            });

            const decision = coordinator.observeLifecycleSignal({
                agentId: 'subagent-1',
                agentSessionId: 'claude-session',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId: created.terminal!.id,
            });

            expect(decision).toBe('subagentUnmatched');
            expect(database.getTerminal(created.terminal!.id)?.agentSessionId).toBeUndefined();
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
                lastAttentionKind: undefined,
            });
        } finally {
            await coordinator.close();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('waits for every active Claude subagent after the parent turn finishes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-subagent-running-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(database, createAgents(), () => {}, logger);
        const terminalId = created.terminal!.id;

        try {
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId,
            });
            for (const agentId of ['subagent-1', 'subagent-2']) {
                coordinator.observeLifecycleSignal({
                    agentId,
                    launchId: 'launch-1',
                    phase: 'subagentStarted',
                    provider: 'claude',
                    terminalId,
                });
            }

            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });

            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
            });

            coordinator.observeLifecycleSignal({
                agentId: 'subagent-2',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
            });

            /**
             * The last child stopping is not the end of the work: Claude resumes the parent turn on its own right after
             * `SubagentStop`, so the Session must stay running until that resumed turn stops.
             */
            coordinator.observeLifecycleSignal({
                agentId: 'subagent-1',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
            });

            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId,
            });
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 1,
                hasUnread: true,
                agentActivityState: 'completed',
                lastAttentionKind: 'completed',
            });

            coordinator.observeLifecycleSignal({
                agentId: 'subagent-1',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });
            expect(database.getSession(created.session.id)?.attentionGeneration).toBe(1);
        } finally {
            await coordinator.close();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('settles a deferred Claude completion when no parent turn resumes after the last subagent', async () => {
        vi.useFakeTimers();
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-subagent-no-resume-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const applied = vi.fn<(signal: AgentLifecycleSignal) => void>();
        const coordinator = new AgentCoordinator(database, createAgents(), () => {}, logger, {
            onLifecycleApplied: applied,
        });
        const terminalId = created.terminal!.id;
        const signal = (
            phase: 'turnStarted' | 'turnFinished' | 'subagentStarted',
            agentId?: string,
        ) =>
            coordinator.observeLifecycleSignal({
                ...(agentId && { agentId }),
                launchId: 'launch-1',
                phase,
                provider: 'claude',
                terminalId,
            });

        try {
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            signal('turnStarted');
            signal('subagentStarted', 'subagent-1');
            signal('turnFinished');
            signal('turnFinished', 'subagent-1');

            vi.advanceTimersByTime(9_999);
            expect(applied).not.toHaveBeenCalledWith(
                expect.objectContaining({ phase: 'turnFinished' }),
            );
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                agentActivityState: 'running',
            });
            vi.advanceTimersByTime(1);
            expect(applied).toHaveBeenCalledWith(
                expect.objectContaining({ phase: 'turnFinished', terminalId }),
            );
            expect(
                applied.mock.calls.filter(([event]) => event.phase === 'turnFinished'),
            ).toHaveLength(1);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 1,
                hasUnread: true,
                agentActivityState: 'completed',
                lastAttentionKind: 'completed',
            });
        } finally {
            vi.useRealTimers();
            await coordinator.close();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps a Claude Session running in the background while reported work runs', async () => {
        vi.useFakeTimers();
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-background-work-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const emitted = vi.fn();
        const coordinator = new AgentCoordinator(database, createAgents(), emitted, logger);
        const terminalId = created.terminal!.id;
        const signal = (phase: 'turnStarted' | 'turnFinished', hasBackgroundWork = false) =>
            coordinator.observeLifecycleSignal({
                ...(hasBackgroundWork && { agentBackgroundWork: true }),
                launchId: 'launch-1',
                phase,
                provider: 'claude',
                terminalId,
            });

        try {
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            signal('turnStarted');
            emitted.mockClear();
            signal('turnFinished', true);

            expect(coordinator.agentOperation(terminalId)).toBe('background');
            expect(emitted).toHaveBeenCalled();
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                agentActivityState: 'running',
            });

            emitted.mockClear();
            signal('turnStarted');
            expect(coordinator.agentOperation(terminalId)).toBeUndefined();
            expect(emitted).toHaveBeenCalled();

            signal('turnFinished');
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 1,
                agentActivityState: 'completed',
            });
        } finally {
            vi.useRealTimers();
            await coordinator.close();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps a hook-started turn running when a probe has no provider evidence', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-turn-probe-unknown-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        /**
         * The exact shape `AgentService.snapshot` produces for a live process whose Claude store cannot be matched yet:
         * the process is alive (`unknown`), nothing else is known.
         */
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                available: true,
                observedAt: Date.now(),
                provider: 'claude',
                status: 'unknown',
            }),
        );
        const logger = new StructuredLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            logger,
        );
        const terminalId = created.terminal!.id;
        const signal = (
            phase: 'turnStarted' | 'turnFinished' | 'subagentStarted',
            agentId?: string,
        ) =>
            coordinator.observeLifecycleSignal({
                ...(agentId && { agentId }),
                launchId: 'launch-1',
                phase,
                provider: 'claude',
                terminalId,
            });

        try {
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            await coordinator.probeTerminalNow(terminalId);
            signal('turnStarted');
            signal('subagentStarted', 'subagent-1');

            await coordinator.probeTerminalNow(terminalId);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
            });

            signal('turnFinished');
            await coordinator.probeTerminalNow(terminalId);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
            });

            signal('turnFinished', 'subagent-1');
            await coordinator.probeTerminalNow(terminalId);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
            });

            signal('turnStarted');
            signal('turnFinished');
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 1,
                hasUnread: true,
                agentActivityState: 'completed',
                lastAttentionKind: 'completed',
            });
            await coordinator.probeTerminalNow(terminalId);
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 1,
                agentActivityState: 'completed',
            });
        } finally {
            await coordinator.close();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each(['escape', 'control'] as const)(
        'lets a probe demote a hook-started turn after %s interrupts it',
        async (entry) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-turn-interrupted-'));
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, 'claude');
            const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
                Promise.resolve({
                    available: true,
                    observedAt: Date.now(),
                    provider: 'claude',
                    status: 'unknown',
                }),
            );
            const logger = new StructuredLogger(join(directory, 'logs'));
            const coordinator = new AgentCoordinator(
                database,
                createAgents(snapshot),
                () => {},
                logger,
            );
            const terminalId = created.terminal!.id;

            try {
                coordinator.beginTerminalLaunch(terminalId, 'launch-1');
                await coordinator.probeTerminalNow(terminalId);
                coordinator.observeLifecycleSignal({
                    launchId: 'launch-1',
                    phase: 'turnStarted',
                    provider: 'claude',
                    terminalId,
                });
                await coordinator.probeTerminalNow(terminalId);
                expect(database.getSession(created.session.id)?.agentActivityState).toBe('running');

                /**
                 * Neither provider fires `Stop` for a user interrupt, so the standalone Escape is the only evidence
                 * that the turn ended; the next probe must be free to read the idle process again.
                 */
                coordinator.observeInterrupt(terminalId, 'stale-launch');
                await coordinator.probeTerminalNow(terminalId);
                expect(database.getSession(created.session.id)?.agentActivityState).toBe('running');
                if (entry === 'escape') coordinator.observeInput(terminalId, '\u{1B}');
                else coordinator.observeInterrupt(terminalId, 'launch-1');
                expect(database.getSession(created.session.id)?.agentActivityState).toBe('running');
                await coordinator.probeTerminalNow(terminalId);
                expect(database.getSession(created.session.id)?.agentActivityState).toBe('unknown');
                const probe = vi.spyOn(coordinator, 'probeTerminal');
                for (let count = 0; count < 20; count += 1)
                    coordinator.observeInput(terminalId, '\u{1B}');
                expect(probe).not.toHaveBeenCalled();
            } finally {
                await coordinator.close();
                database.close();
                await logger.flush();
                await rm(directory, { recursive: true, force: true });
            }
        },
    );

    it('keeps deferred hook lifecycle authoritative over Claude metadata probes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-subagent-metadata-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                attentionKind: 'waiting',
                available: true,
                observedAt: Date.now(),
                provider: 'claude',
                sessionId: 'claude-session',
                status: 'waiting',
            }),
        );
        const logger = new StructuredLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            logger,
        );
        const terminalId = created.terminal!.id;

        try {
            coordinator.beginTerminalLaunch(terminalId, 'launch-1');
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnStarted',
                provider: 'claude',
                terminalId,
            });
            coordinator.observeLifecycleSignal({
                agentId: 'subagent-1',
                launchId: 'launch-1',
                phase: 'subagentStarted',
                provider: 'claude',
                terminalId,
            });
            coordinator.observeLifecycleSignal({
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });

            coordinator.probeTerminal(terminalId);
            await expect
                .poll(() => database.getTerminal(terminalId)?.agentSessionId)
                .toBe('claude-session');
            expect(snapshot).toHaveBeenCalledOnce();
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionGeneration: 0,
                hasUnread: false,
                agentActivityState: 'running',
                lastAttentionKind: undefined,
            });
        } finally {
            await coordinator.close();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
