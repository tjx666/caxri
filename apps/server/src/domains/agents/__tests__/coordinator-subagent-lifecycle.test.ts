import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

function createAgents(): AgentService {
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const snapshot: AgentAdapter['snapshot'] = () => Promise.reject(new Error('not used'));
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

            const handled = coordinator.observeLifecycleSignal({
                agentId: 'subagent-1',
                agentSessionId: 'claude-session',
                launchId: 'launch-1',
                phase: 'turnFinished',
                provider: 'claude',
                terminalId: created.terminal!.id,
            });

            expect(handled).toBe(false);
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
});
