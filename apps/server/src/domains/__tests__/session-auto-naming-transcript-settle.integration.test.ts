import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshot } from '@caxri/protocol';
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
    vi.useRealTimers();
    const pending = [...cleanups];
    cleanups.length = 0;
    await Promise.all(pending.map((cleanup) => cleanup()));
    vi.restoreAllMocks();
});

const USER_ONLY = { opening: [{ role: 'user' as const, text: 'hello' }], recent: [] };
const EMPTY = { opening: [], recent: [] };
const WITH_REPLY = {
    opening: [
        { role: 'user' as const, text: 'hello' },
        { role: 'assistant' as const, text: 'Hi, what are we working on today?' },
    ],
    recent: [],
};

function namingReasons(log: { mock: { calls: unknown[][] } }) {
    return log.mock.calls
        .filter((call) => call[1] === logEventCatalog.agent.automaticNamingFinished)
        .map((call) => {
            const { reason, trigger } = (call[2] as { fields: { reason: string; trigger: string } })
                .fields;
            return `${trigger}:${reason}`;
        });
}

/**
 * A first-turn Session whose transcript is read through spies, so each read can return what the file held at that
 * moment.
 */
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-naming-settle-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const projectId = database.createProject(directory).id;
    const created = database.createSession(projectId, 'codex', directory);
    const sessionId = created.session.id;
    const terminalId = created.terminal!.id;
    database.rebindAgentSession(terminalId, 'codex', 'fixture-agent');
    let nativeTitle: string | undefined;
    const snapshot = (): AgentSnapshot => ({
        provider: 'codex',
        available: true,
        status: 'completed',
        observedAt: Date.now() + 100,
        sessionId: 'fixture-agent',
        title: nativeTitle,
    });
    const agents = new AgentService(
        undefined,
        createPendingAgentAdapters({
            codex: {
                provider: 'codex',
                renameSession: ({ title }: { title: string }) => {
                    nativeTitle = title;
                    return Promise.resolve({ title });
                },
                snapshot: () => Promise.resolve(snapshot()),
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
        service,
        sessionId,
        finishTurn: () =>
            service.observe({
                provider: 'codex',
                terminalId,
                launchId: 'fixture-launch',
                phase: 'turnFinished',
                agentSessionId: 'fixture-agent',
            }),
        startTurn: () =>
            service.observe({
                provider: 'codex',
                terminalId,
                launchId: 'fixture-launch',
                phase: 'turnStarted',
                agentSessionId: 'fixture-agent',
            }),
    };
}

describe('Automatic Session naming while the transcript settles', () => {
    it('re-reads a transcript that lacked the finished reply when the Stop hook arrived', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        const read = vi
            .spyOn(agentFunctions, 'readAgentTitleMessages')
            .mockResolvedValueOnce(USER_ONLY)
            .mockResolvedValue({
                opening: [
                    { role: 'user', text: 'hello' },
                    { role: 'assistant', text: 'Hi, what are we working on today?' },
                ],
                recent: [],
            });
        const generate = vi.spyOn(f.agents, 'generateTitle').mockResolvedValue('Greeting');
        f.finishTurn();
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        expect(generate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);
        await vi.waitFor(() => expect(f.database.getSession(f.sessionId)?.title).toBe('Greeting'));
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('stops re-reading a transcript that never gains a reply', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        const read = vi
            .spyOn(agentFunctions, 'readAgentTitleMessages')
            .mockResolvedValue(USER_ONLY);
        f.finishTurn();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read).toHaveBeenCalledTimes(4);
        const reasons = f.log.mock.calls
            .filter((call) => call[1] === logEventCatalog.agent.automaticNamingFinished)
            .map((call) => (call[2] as { fields: { reason: string } }).fields.reason);
        expect(reasons).toEqual([
            'transcriptPending',
            'transcriptPending',
            'transcriptPending',
            'insufficientContext',
        ]);
    });
});

describe('Automatic Session naming when the first turn starts', () => {
    it('names the Session from the opening request before the turn finishes', async () => {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue(USER_ONLY);
        const generate = vi.spyOn(f.agents, 'generateTitle').mockResolvedValue('Greeting');
        f.startTurn();
        await vi.waitFor(() => expect(f.database.getSession(f.sessionId)?.title).toBe('Greeting'));
        expect(namingReasons(f.log)).toEqual(['turnStarted:completed']);
        // Completed naming state ends naming synchronously, so the finished turn starts no attempt.
        f.finishTurn();
        expect(namingReasons(f.log)).toEqual(['turnStarted:completed']);
        expect(generate).toHaveBeenCalledOnce();
    });

    it('re-reads a transcript that does not hold the submitted request yet', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        const read = vi
            .spyOn(agentFunctions, 'readAgentTitleMessages')
            .mockResolvedValueOnce(EMPTY)
            .mockResolvedValue(USER_ONLY);
        const generate = vi.spyOn(f.agents, 'generateTitle').mockResolvedValue('Greeting');
        f.startTurn();
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        expect(generate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);
        await vi.waitFor(() => expect(f.database.getSession(f.sessionId)?.title).toBe('Greeting'));
        expect(namingReasons(f.log)).toEqual([
            'turnStarted:transcriptPending',
            'turnStarted:completed',
        ]);
    });

    it('leaves a request without a subject to the completed turn, without a cooldown', async () => {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'readAgentTitleMessages')
            .mockResolvedValueOnce(USER_ONLY)
            .mockResolvedValue(WITH_REPLY);
        const generate = vi
            .spyOn(f.agents, 'generateTitle')
            .mockResolvedValueOnce('SKIP')
            .mockResolvedValue('Greeting');
        f.startTurn();
        await vi.waitFor(() => expect(namingReasons(f.log)).toEqual(['turnStarted:skipped']));
        expect(f.database.getSession(f.sessionId)?.title).not.toBe('Greeting');
        f.finishTurn();
        await vi.waitFor(() => expect(f.database.getSession(f.sessionId)?.title).toBe('Greeting'));
        expect(generate).toHaveBeenCalledTimes(2);
        expect(namingReasons(f.log).at(-1)).toBe('turnFinished:completed');
    });

    it('replays a turn that finishes while the opening attempt is still generating', async () => {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'readAgentTitleMessages')
            .mockResolvedValueOnce(USER_ONLY)
            .mockResolvedValue(WITH_REPLY);
        const opening = Promise.withResolvers<string>();
        const generate = vi
            .spyOn(f.agents, 'generateTitle')
            .mockReturnValueOnce(opening.promise)
            .mockResolvedValue('Greeting');
        f.startTurn();
        await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
        f.finishTurn();
        opening.resolve('SKIP');
        await vi.waitFor(() => expect(f.database.getSession(f.sessionId)?.title).toBe('Greeting'));
        expect(namingReasons(f.log)).toEqual(['turnStarted:skipped', 'turnFinished:completed']);
    });

    it('hands a still-settling opening attempt over to the finished turn', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        const read = vi
            .spyOn(agentFunctions, 'readAgentTitleMessages')
            .mockResolvedValueOnce(EMPTY)
            .mockResolvedValue(WITH_REPLY);
        vi.spyOn(f.agents, 'generateTitle').mockResolvedValue('Greeting');
        f.startTurn();
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        f.finishTurn();
        await vi.waitFor(() => expect(f.database.getSession(f.sessionId)?.title).toBe('Greeting'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read).toHaveBeenCalledTimes(2);
        expect(namingReasons(f.log)).toEqual([
            'turnStarted:transcriptPending',
            'turnFinished:completed',
        ]);
    });

    it('gives a turn that finishes during the opening read its full settle budget', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        const opening = Promise.withResolvers<typeof EMPTY>();
        const read = vi
            .spyOn(agentFunctions, 'readAgentTitleMessages')
            .mockReturnValueOnce(opening.promise)
            .mockResolvedValue(USER_ONLY);
        f.startTurn();
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        f.finishTurn();
        opening.resolve(EMPTY);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read).toHaveBeenCalledTimes(5);
        expect(namingReasons(f.log)).toEqual([
            'turnStarted:insufficientContext',
            'turnFinished:transcriptPending',
            'turnFinished:transcriptPending',
            'turnFinished:transcriptPending',
            'turnFinished:insufficientContext',
        ]);
    });
});
