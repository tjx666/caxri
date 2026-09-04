import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

function createAgents(
    snapshot: AgentAdapter['snapshot'] = () => Promise.reject(new Error('not used')),
): AgentService {
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const adapters: Record<AgentProvider, AgentAdapter> = {
        claude: { provider: 'claude', renameSession, snapshot },
        codex: { provider: 'codex', renameSession, snapshot },
    };
    return new AgentService(undefined, adapters);
}

describe('AgentCoordinator subagent lifecycle', () => {
    it('ignores a Claude subagent completion for Session activity and attention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-subagent-finished-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
        );

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
                attentionEpoch: 0,
                hasUnread: false,
                lastActivityState: 'running',
                lastAttentionKind: undefined,
            });
        } finally {
            coordinator.close();
            database.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('waits for every active Claude subagent after the parent turn finishes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-subagent-running-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'claude');
        const coordinator = new AgentCoordinator(
            database,
            createAgents(),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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
                attentionEpoch: 0,
                hasUnread: false,
                lastActivityState: 'running',
            });

            coordinator.observeLifecycleSignal({
                agentId: 'subagent-2',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionEpoch: 0,
                hasUnread: false,
                lastActivityState: 'running',
            });

            coordinator.observeLifecycleSignal({
                agentId: 'subagent-1',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });
            expect(database.getSession(created.session.id)).toMatchObject({
                attentionEpoch: 1,
                hasUnread: true,
                lastActivityState: 'completed',
                lastAttentionKind: 'completed',
            });

            coordinator.observeLifecycleSignal({
                agentId: 'subagent-1',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId,
            });
            expect(database.getSession(created.session.id)?.attentionEpoch).toBe(1);
        } finally {
            coordinator.close();
            database.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

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
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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
                attentionEpoch: 0,
                hasUnread: false,
                lastActivityState: 'running',
                lastAttentionKind: undefined,
            });
        } finally {
            coordinator.close();
            database.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
