import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logEventCatalog, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as agentFunctions from '../agents';
import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionAutoNamingService } from '../session/auto-naming';
import { SessionRenameService } from '../session/rename';
import { createPendingAgentAdapters } from './create-test-domain-services';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    const pending = [...cleanups];
    cleanups.length = 0;
    await Promise.all(pending.map((cleanup) => cleanup()));
    vi.restoreAllMocks();
});

const CONVERSATION = {
    opening: [
        { role: 'user' as const, text: 'Back up the session transcript before compaction' },
        { role: 'assistant' as const, text: 'I will add a backup step to the compaction flow.' },
    ],
    recent: [],
};

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-title-suggestion-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const projectId = database.createProject(directory).id;
    const created = database.createSession(projectId, 'codex', directory);
    database.rebindAgentSession(created.terminal!.id, 'codex', 'fixture-agent');
    const agents = new AgentService(
        undefined,
        createPendingAgentAdapters({
            codex: {
                provider: 'codex',
                renameSession: ({ displayTitle }: { displayTitle: string }) =>
                    Promise.resolve({ displayTitle }),
                snapshot: () =>
                    Promise.resolve({
                        provider: 'codex',
                        available: true,
                        status: 'completed',
                        observedAt: Date.now(),
                        sessionId: 'fixture-agent',
                    }),
            },
        }),
    );
    const logger = new StructuredLogger(join(directory, 'logs'));
    const coordinator = new AgentCoordinator(database, agents, () => {}, logger);
    const renames = new SessionRenameService(database, agents, coordinator, () => {}, logger);
    const service = new SessionAutoNamingService(
        database,
        agents,
        renames,
        { homeDirectory: directory, variables: {} },
        () => true,
        logger,
    );
    cleanups.push(async () => {
        await service.close();
        await coordinator.close();
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    });
    vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
        baseRoot: directory,
        root: directory,
        path: join(directory, 'fixture.jsonl'),
    });
    return {
        agents,
        database,
        log: vi.spyOn(logger, 'write'),
        renames,
        service,
        sessionId: created.session.id,
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function suggestionReasons(log: Fixture['log']): string[] {
    return log.mock.calls
        .filter((call) => call[1] === logEventCatalog.agent.titleSuggestionFinished)
        .map((call) => (call[2] as { fields: { reason: string } }).fields.reason);
}

describe('Session title suggestion', () => {
    it('suggests a title for a manually named Session without applying it', async () => {
        const f = await fixture();
        await f.renames.rename(f.sessionId, 'Typed by hand');
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue(CONVERSATION);
        const generate = vi
            .spyOn(f.agents, 'generateTitle')
            .mockResolvedValue('Session transcript backup');

        await expect(f.service.suggestTitle(f.sessionId)).resolves.toEqual({
            displayTitle: 'Session transcript backup',
        });
        expect(generate).toHaveBeenCalledOnce();
        expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Typed by hand');
        expect(suggestionReasons(f.log)).toEqual(['completed']);
    });

    it('rejects a Session whose conversation has nothing to name yet', async () => {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
            opening: [{ role: 'user', text: 'hello' }],
            recent: [],
        });
        const generate = vi.spyOn(f.agents, 'generateTitle');

        await expect(f.service.suggestTitle(f.sessionId)).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(generate).not.toHaveBeenCalled();
        expect(suggestionReasons(f.log)).toEqual(['insufficientContext']);
    });

    it('records a provider failure with its closed cause', async () => {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue(CONVERSATION);
        vi.spyOn(f.agents, 'generateTitle').mockRejectedValue(
            Object.assign(new Error('boom'), { exitCode: 1 }),
        );

        await expect(f.service.suggestTitle(f.sessionId)).rejects.toThrow('boom');
        const finished = f.log.mock.calls.find(
            (call) => call[1] === logEventCatalog.agent.titleSuggestionFinished,
        );
        expect(finished?.[0]).toBe('warn');
        expect(finished?.[2]).toMatchObject({ fields: { failure: 'exit', reason: 'failed' } });
    });
});
