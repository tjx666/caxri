import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as agentFunctions from '../agents';
import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionAutoNamingService } from '../session-auto-naming';
import { SessionRenameService } from '../session-rename';
import { createPendingAgentAdapters } from './create-test-domain-services';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    const pending = cleanups.slice();
    cleanups.length = 0;
    await Promise.all(pending.map((cleanup) => cleanup()));
    vi.restoreAllMocks();
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-naming-sync-'));
    const path = join(directory, 'state.db');
    const database = new CaxriDatabase(path);
    const created = database.createSession(
        database.createProject(directory).id,
        'codex',
        directory,
    );
    const terminalId = created.terminal!.id;
    const sessionId = created.session.id;
    database.rebindAgentSession(terminalId, 'codex', 'test-agent');
    const target = {
        terminalId,
        agentSessionId: 'test-agent',
        provider: 'codex' as const,
        cwd: directory,
    };
    let nativeTitle = 'Analyze image';
    const snapshot = (): AgentSnapshot => ({
        provider: 'codex',
        available: true,
        status: 'completed',
        observedAt: Date.now() + 100,
        sessionId: 'test-agent',
        title: nativeTitle,
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
    const coordinator = new AgentCoordinator(
        database,
        agents,
        () => {},
        new StructuredLogger(join(directory, 'logs')),
    );
    const renames = new SessionRenameService(database, agents, coordinator, () => {});
    cleanups.push(async () => {
        coordinator.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const automatic = () =>
        renames.renameAutomatically(
            sessionId,
            target,
            'Session title synchronization',
            () => true,
            new AbortController().signal,
        );
    return {
        agents,
        directory,
        database,
        renames,
        rename,
        automatic,
        sessionId,
        terminalId,
        target,
        snapshot,
        setNativeTitle: (title: string) => {
            nativeTitle = title;
        },
    };
}

describe('Automatic Session rename synchronization', () => {
    it('retains a useful completed turn received during the insufficient-context cooldown', async () => {
        const f = await fixture();
        vi.useFakeTimers();
        vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
            baseRoot: f.directory,
            root: f.directory,
            path: join(f.directory, 'fixture.jsonl'),
        });
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue([
            { role: 'user', text: 'Fix title synchronization' },
            { role: 'assistant', text: 'The native title precedence was wrong' },
        ]);
        const generate = vi
            .spyOn(f.agents, 'generateTitle')
            .mockResolvedValueOnce('SKIP')
            .mockResolvedValue('Concrete task title');
        const logger = new StructuredLogger(join(f.directory, 'logs'));
        const log = vi.spyOn(logger, 'write');
        const service = new SessionAutoNamingService(
            f.database,
            f.agents,
            f.renames,
            { homeDirectory: f.directory, variables: {} },
            () => true,
            logger,
        );
        const event = {
            provider: 'codex' as const,
            terminalId: f.terminalId,
            launchId: 'test-launch',
            phase: 'turnFinished' as const,
            agentSessionId: f.target.agentSessionId,
        };
        try {
            service.observe(event);
            await vi.waitFor(() => expect(log).toHaveBeenCalled());
            service.observe(event);
            expect(generate).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Concrete task title');
            expect(f.rename).toHaveBeenCalledOnce();
        } finally {
            await service.close();
            vi.useRealTimers();
        }
    });

    it('retains a newer completed turn while an older generation is being cancelled', async () => {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
            baseRoot: f.directory,
            root: f.directory,
            path: join(f.directory, 'fixture.jsonl'),
        });
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue([
            { role: 'user', text: 'Fix title synchronization' },
            { role: 'assistant', text: 'The native title precedence was wrong' },
        ]);
        const older = Promise.withResolvers<string>();
        const generate = vi
            .spyOn(f.agents, 'generateTitle')
            .mockReturnValueOnce(older.promise)
            .mockResolvedValue('Current task title');
        const service = new SessionAutoNamingService(
            f.database,
            f.agents,
            f.renames,
            { homeDirectory: f.directory, variables: {} },
            () => true,
            new StructuredLogger(join(f.directory, 'logs')),
        );
        const event = {
            provider: 'codex' as const,
            terminalId: f.terminalId,
            launchId: 'test-launch',
            agentSessionId: f.target.agentSessionId,
        };
        try {
            service.observe({ ...event, phase: 'turnFinished' });
            await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
            service.observe({ ...event, phase: 'turnStarted' });
            service.observe({ ...event, phase: 'turnFinished' });
            older.resolve('Obsolete task title');
            await vi.waitFor(() =>
                expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Current task title'),
            );
            expect(f.rename).toHaveBeenCalledOnce();
        } finally {
            older.resolve('Obsolete task title');
            await service.close();
        }
    });

    it('discards a generated result when the user renames during generation', async () => {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
            baseRoot: f.directory,
            root: f.directory,
            path: join(f.directory, 'fixture.jsonl'),
        });
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue([
            { role: 'user', text: 'Fix title synchronization' },
            { role: 'assistant', text: 'The native title precedence was wrong' },
        ]);
        const generation = Promise.withResolvers<string>();
        const generate = vi.spyOn(f.agents, 'generateTitle').mockReturnValue(generation.promise);
        const logger = new StructuredLogger(join(f.directory, 'logs'));
        const settled = Promise.withResolvers<void>();
        vi.spyOn(logger, 'write').mockImplementation(() => settled.resolve());
        const service = new SessionAutoNamingService(
            f.database,
            f.agents,
            f.renames,
            { homeDirectory: f.directory, variables: {} },
            () => true,
            logger,
        );
        try {
            service.observe({
                provider: 'codex',
                terminalId: f.terminalId,
                launchId: 'test-launch',
                phase: 'turnFinished',
                agentSessionId: f.target.agentSessionId,
            });
            await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
            await f.renames.rename(f.sessionId, 'User chosen name');
            generation.resolve('Stale generated name');
            await settled.promise;
            expect(f.rename).toHaveBeenCalledOnce();
            expect(f.database.getSession(f.sessionId)).toMatchObject({
                displayTitle: 'User chosen name',
                titleMode: 'manual',
            });
        } finally {
            generation.resolve('Stale generated name');
            await service.close();
        }
    });

    it('continues reading subsequent Codex names without generating or writing again', async () => {
        const f = await fixture();
        await f.automatic();
        f.database.updateAgentMetadata(f.terminalId, {
            ...f.snapshot(),
            title: 'Native follow-up name',
        });
        expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Native follow-up name');
        expect(await f.automatic()).toBe(false);
        expect(f.rename).toHaveBeenCalledOnce();
    });

    it('keeps completion across reopening the database', async () => {
        const f = await fixture();
        await f.automatic();
        const reopened = new CaxriDatabase(join(f.directory, 'state.db'));
        const coordinator = new AgentCoordinator(
            reopened,
            f.agents,
            () => {},
            new StructuredLogger(join(f.directory, 'reopened-logs')),
        );
        try {
            const renames = new SessionRenameService(reopened, f.agents, coordinator, () => {});
            expect(
                await renames.renameAutomatically(
                    f.sessionId,
                    f.target,
                    'Must not regenerate',
                    () => true,
                    new AbortController().signal,
                ),
            ).toBe(false);
            expect(reopened.getSession(f.sessionId)?.displayTitle).toBe(
                'Session title synchronization',
            );
            expect(f.rename).toHaveBeenCalledOnce();
        } finally {
            coordinator.close();
            reopened.close();
        }
    });

    it('syncs once, persists completion, and ignores later AI and stale readback titles', async () => {
        const f = await fixture();
        expect(await f.automatic()).toBe(true);
        expect(await f.automatic()).toBe(false);
        expect(f.rename).toHaveBeenCalledOnce();
        expect(f.database.automaticSessionNaming(f.sessionId)?.status).toBe('complete');
        f.database.updateAgentMetadata(f.terminalId, {
            ...f.snapshot(),
            title: 'Analyze image again',
            titleSource: 'automatic',
        });
        f.database.updateAgentMetadata(f.terminalId, {
            ...f.snapshot(),
            title: 'Old explicit name',
            titleSource: 'explicit',
            observedAt: 1,
        });
        expect(f.database.getSession(f.sessionId)).toMatchObject({
            displayTitle: 'Session title synchronization',
            titleMode: 'automatic',
        });
    });

    it('preserves an external explicit rename and prevents future automatic overwrites', async () => {
        const f = await fixture();
        await f.automatic();
        f.database.updateAgentMetadata(f.terminalId, {
            ...f.snapshot(),
            title: 'User chosen title',
            titleSource: 'explicit',
        });
        expect(f.database.getSession(f.sessionId)).toMatchObject({
            displayTitle: 'User chosen title',
            titleMode: 'manual',
        });
        expect(await f.automatic()).toBe(false);
        expect(f.rename).toHaveBeenCalledOnce();
    });

    it('recovers a pending intent after provider success without repeating the native rename', async () => {
        const f = await fixture();
        f.database.setAutomaticSessionNaming(f.sessionId, {
            ...f.target,
            title: 'Recovered title',
            previousTitle: 'Analyze image',
            status: 'pending',
            updatedAt: 1,
        });
        f.setNativeTitle('Recovered title');
        expect(await f.automatic()).toBe(true);
        expect(f.rename).not.toHaveBeenCalled();
        expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Recovered title');
    });

    it('serializes a manual request after an in-flight automatic write and leaves manual ownership', async () => {
        const f = await fixture();
        const pending = Promise.withResolvers<{ displayTitle: string }>();
        f.rename.mockImplementationOnce(() => pending.promise);
        const automatic = f.automatic();
        await vi.waitFor(() => expect(f.rename).toHaveBeenCalledOnce());
        const manual = f.renames.rename(f.sessionId, 'Manual final title');
        pending.resolve({ displayTitle: 'Automatic intermediate title' });
        await automatic;
        await manual;
        expect(f.database.getSession(f.sessionId)).toMatchObject({
            displayTitle: 'Manual final title',
            titleMode: 'manual',
        });
        f.database.updateAgentMetadata(f.terminalId, {
            ...f.snapshot(),
            title: 'Late provider title',
            titleSource: 'explicit',
        });
        expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Manual final title');
    });

    it('does not follow a rebound primary Agent with a stale generated title', async () => {
        const f = await fixture();
        const pending = Promise.withResolvers<{ displayTitle: string }>();
        f.rename.mockImplementationOnce(() => pending.promise);
        const automatic = f.automatic();
        await vi.waitFor(() => expect(f.rename).toHaveBeenCalledOnce());
        f.database.rebindAgentSession(f.terminalId, 'codex', 'different-agent');
        pending.resolve({ displayTitle: 'Old task title' });
        expect(await automatic).toBe(false);
        expect(f.rename).toHaveBeenCalledOnce();
        expect(f.database.getSession(f.sessionId)?.displayTitle).not.toBe('Old task title');
        f.database.updateAgentMetadata(f.terminalId, {
            ...f.snapshot(),
            sessionId: 'different-agent',
            title: 'New binding title',
            titleSource: 'automatic',
        });
        expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('New binding title');
        expect(f.database.automaticSessionNaming(f.sessionId)?.status).toBe('stopped');
    });
});
