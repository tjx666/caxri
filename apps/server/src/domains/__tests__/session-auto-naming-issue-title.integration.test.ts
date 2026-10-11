import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as agentFunctions from '../agents';
import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionAutoNamingService } from '../session/auto-naming';
import { SessionRenameService } from '../session/rename';
import { createPendingAgentAdapters } from './create-test-domain-services';

afterEach(() => vi.restoreAllMocks());

describe('Automatic Session naming from an issue-only request', () => {
    it.each([
        {
            source: undefined,
            expected: '会话标题同步',
            firstCandidate: '会话标题同步',
            attempts: 1,
        },
        { source: undefined, expected: '会话标题同步', firstCandidate: 'TASK-1234', attempts: 2 },
        {
            source: undefined,
            expected: '会话标题同步',
            firstCandidate: 'Session title sync',
            attempts: 2,
        },
        {
            source: 'explicit' as const,
            expected: 'TASK-1234',
            firstCandidate: '会话标题同步',
            attempts: 0,
        },
    ])(
        'preserves explicit native ownership: $source / $firstCandidate',
        async ({ source, expected, firstCandidate, attempts }) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-issue-title-'));
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const projectId = database.createProject(directory).id;
            const created = database.createSession(projectId, 'codex', directory);
            const sessionId = created.session.id;
            const terminalId = created.terminal!.id;
            const agentSessionId = 'fixture-agent';
            database.rebindAgentSession(terminalId, 'codex', agentSessionId);
            let nativeTitle = 'TASK-1234';
            const snapshot = (): AgentSnapshot => ({
                provider: 'codex',
                available: true,
                status: 'completed',
                observedAt: Date.now() + 100,
                sessionId: agentSessionId,
                title: nativeTitle,
                titleSource: source,
            });
            const rename = vi.fn(({ displayTitle }: { displayTitle: string }) => {
                nativeTitle = displayTitle;
                return Promise.resolve({ displayTitle });
            });
            const agents = new AgentService(
                undefined,
                createPendingAgentAdapters({
                    codex: {
                        provider: 'codex',
                        renameSession: rename,
                        snapshot: () => Promise.resolve(snapshot()),
                    },
                }),
            );
            const logger = new StructuredLogger(join(directory, 'logs'));
            const coordinator = new AgentCoordinator(database, agents, () => {}, logger);
            const renames = new SessionRenameService(
                database,
                agents,
                coordinator,
                () => {},
                logger,
            );
            const service = new SessionAutoNamingService(
                database,
                agents,
                renames,
                { homeDirectory: directory, variables: {} },
                () => true,
                logger,
            );
            vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
                baseRoot: directory,
                root: directory,
                path: join(directory, 'fixture.jsonl'),
            });
            vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
                opening: [
                    { role: 'user', text: 'TASK-1234' },
                    { role: 'assistant', text: '需要修复会话标题同步。' },
                ],
                recent: [],
            });
            const generate = vi
                .spyOn(agents, 'generateTitle')
                .mockResolvedValueOnce(firstCandidate)
                .mockResolvedValue('会话标题同步');
            try {
                service.observe({
                    provider: 'codex',
                    terminalId,
                    launchId: 'fixture-launch',
                    phase: 'turnFinished',
                    agentSessionId,
                });
                if (attempts > 0)
                    await vi.waitFor(() =>
                        expect(database.automaticSessionNaming(sessionId)).toBeDefined(),
                    );
                await vi.waitFor(() =>
                    expect(database.getSession(sessionId)?.displayTitle).toBe(expected),
                );
                expect(generate).toHaveBeenCalledTimes(attempts);
                if (attempts === 2) expect(generate.mock.calls[1]?.[1].prompt).toContain('<retry>');
                expect(rename).toHaveBeenCalledTimes(attempts > 0 ? 1 : 0);
            } finally {
                await service.close();
                coordinator.close();
                database.close();
                await logger.flush();
                await rm(directory, { recursive: true, force: true });
            }
        },
    );
});
