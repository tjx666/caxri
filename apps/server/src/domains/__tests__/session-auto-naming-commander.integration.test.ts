import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionAutoNamingService } from '../session/auto-naming';
import { SessionRenameService } from '../session/rename';
import { createPendingAgentAdapters } from './create-test-domain-services';

afterEach(() => vi.restoreAllMocks());

describe("Automatic Session naming of the Agent Commander's Session", () => {
    /**
     * The Commander's hidden Session carries every task in turn. Claude Code also shows a native rename on the
     * Commander's composer, so naming it from one request would mislabel the conversation for the next.
     */
    it('leaves the Commander Session unnamed while naming a user Session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-naming-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const projectId = database.createProject(directory).id;
        const bind = () => {
            const created = database.createSession(projectId, 'codex', directory);
            const terminalId = created.terminal!.id;
            const agentSessionId = `agent-${created.session.id}`;
            database.rebindAgentSession(terminalId, 'codex', agentSessionId);
            return { agentSessionId, sessionId: created.session.id, terminalId };
        };
        const commander = bind();
        const user = bind();
        database.setAppState('agentCommander', {
            projectId,
            sessionId: commander.sessionId,
            terminalId: commander.terminalId,
            sessionIds: [],
        });
        const agents = new AgentService(
            undefined,
            createPendingAgentAdapters({
                codex: {
                    provider: 'codex',
                    renameSession: ({ displayTitle }) => Promise.resolve({ displayTitle }),
                    snapshot: (): Promise<AgentSnapshot> =>
                        Promise.resolve({
                            provider: 'codex',
                            available: true,
                            status: 'completed',
                            observedAt: Date.now() + 100,
                            title: 'Analyze image',
                            titleSource: 'automatic',
                        }),
                },
            }),
        );
        const snapshot = vi.spyOn(agents, 'snapshot');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const coordinator = new AgentCoordinator(database, agents, () => {}, logger);
        const service = new SessionAutoNamingService(
            database,
            agents,
            new SessionRenameService(database, agents, coordinator, () => {}, logger),
            { homeDirectory: directory, variables: {} },
            () => true,
            logger,
        );
        try {
            /**
             * The user Session is observed second, so once its attempt reads the native title, the Commander's would
             * already have done the same had it been eligible.
             */
            for (const { agentSessionId, terminalId } of [commander, user])
                service.observe({
                    provider: 'codex',
                    terminalId,
                    launchId: 'test-launch',
                    phase: 'turnFinished',
                    agentSessionId,
                });
            await vi.waitFor(() =>
                expect(snapshot).toHaveBeenCalledWith(
                    'codex',
                    expect.objectContaining({ agentSessionId: user.agentSessionId }),
                ),
            );
            expect(snapshot).toHaveBeenCalledOnce();
            expect(database.automaticSessionNaming(commander.sessionId)).toBeUndefined();
        } finally {
            await service.close();
            await coordinator.close();
            database.close();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
