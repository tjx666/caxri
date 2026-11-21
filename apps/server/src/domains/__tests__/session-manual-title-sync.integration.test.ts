import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { ManualTitleSync } from '../session/naming/manual-sync';
import { SessionRenameService } from '../session/naming/rename';
import { createPendingAgentAdapters } from './create-test-domain-services';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    const pending = [...cleanups];
    cleanups.length = 0;
    for (const cleanup of pending) {
        // eslint-disable-next-line no-await-in-loop -- the service closes before its database
        await cleanup();
    }
    vi.restoreAllMocks();
});

/**
 * A Session titled before its Codex conversation existed, the way a `--type` delegation creates one: the title is
 * manual and the native thread has no name of its own yet.
 */
async function fixture(nativeTitle: string | undefined) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-manual-title-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const projectId = database.createProject(directory).id;
    const created = database.createSession(projectId, 'codex', directory);
    const terminalId = created.terminal!.id;
    const sessionId = created.session.id;
    database.renameSession(sessionId, 'Review the retry fix');
    database.rebindAgentSession(terminalId, 'codex', 'test-agent');
    let title = nativeTitle;
    const snapshot = (): AgentSnapshot => ({
        provider: 'codex',
        available: true,
        status: 'completed',
        observedAt: Date.now() + 100,
        sessionId: 'test-agent',
        title,
    });
    const rename = vi.fn(({ title: next }: { title: string }) => {
        title = next;
        return Promise.resolve({ title: next });
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
    const loggers = ['coordinator', 'rename'].map(
        (name) => new StructuredLogger(join(directory, `${name}-logs`)),
    );
    const coordinator = new AgentCoordinator(database, agents, () => {}, loggers[0]);
    const renames = new SessionRenameService(database, agents, coordinator, () => {}, loggers[1]);
    const service = new ManualTitleSync(database, renames, () => true);
    cleanups.push(async () => {
        await service.close();
        await coordinator.close();
        database.close();
        await Promise.all(loggers.map((logger) => logger.flush()));
        await rm(directory, { recursive: true, force: true });
    });
    const turn = (phase: 'turnStarted' | 'turnFinished') =>
        service.observe({
            provider: 'codex',
            terminalId,
            launchId: 'test-launch',
            phase,
            agentSessionId: 'test-agent',
        });
    return { agents, database, rename, sessionId, snapshot, turn };
}

describe('Manual title synchronization once the Agent conversation exists', () => {
    it('names a conversation that started after its Session was titled, once', async () => {
        const f = await fixture(undefined);
        const generate = vi.spyOn(f.agents, 'generateTitle');

        f.turn('turnStarted');
        await vi.waitFor(() => expect(f.snapshot().title).toBe('Review the retry fix'));
        expect(f.rename).toHaveBeenCalledTimes(1);
        expect(f.rename.mock.calls[0]?.[0]).toMatchObject({
            agentSessionId: 'test-agent',
            title: 'Review the retry fix',
        });

        f.turn('turnFinished');
        f.turn('turnStarted');
        expect(f.rename).toHaveBeenCalledTimes(1);
        expect(generate).not.toHaveBeenCalled();
        expect(f.database.getSession(f.sessionId)).toMatchObject({
            title: 'Review the retry fix',
            titleMode: 'manual',
        });
    });

    it('keeps a name the conversation already has', async () => {
        const f = await fixture('Named in Codex');
        const snapshot = vi.spyOn(f.agents, 'snapshot');

        f.turn('turnStarted');
        await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
        await snapshot.mock.results[0]?.value;
        f.turn('turnFinished');

        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(f.rename).not.toHaveBeenCalled();
    });

    it('retries on a later turn when the provider has not recorded the conversation yet', async () => {
        const f = await fixture(undefined);
        const pending = vi
            .spyOn(f.agents, 'snapshot')
            .mockResolvedValueOnce({ ...f.snapshot(), sessionId: undefined });

        f.turn('turnStarted');
        await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
        await pending.mock.results[0]?.value;
        expect(f.rename).not.toHaveBeenCalled();

        await vi.waitFor(() => {
            f.turn('turnFinished');
            expect(f.rename).toHaveBeenCalledTimes(1);
        });
    });

    it('stops retrying a provider write that keeps failing', async () => {
        const f = await fixture(undefined);
        f.rename.mockRejectedValue(new Error('rename unavailable'));

        for (let turn = 0; turn < 3; turn++) {
            // eslint-disable-next-line no-await-in-loop -- each turn waits for the previous attempt to finish
            await vi.waitFor(() => {
                f.turn('turnFinished');
                expect(f.rename).toHaveBeenCalledTimes(turn + 1);
            });
        }
        // Lets the third attempt's rejection settle before the next turns arrive.
        await new Promise((resolve) => setTimeout(resolve, 50));
        f.turn('turnStarted');
        f.turn('turnFinished');

        expect(f.rename).toHaveBeenCalledTimes(3);
    });
});
