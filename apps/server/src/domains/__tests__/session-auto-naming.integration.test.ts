import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshot } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { logEventCatalog, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as agentFunctions from '../agents';
import { AgentCoordinator, AgentService } from '../agents';
import { CaxriDatabase } from '../db';
import { SessionAutoNamingService } from '../session-auto-naming';
import { SessionRenameService } from '../session-rename';
import { createPendingAgentAdapters } from './create-test-domain-services';

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
    const projectId = database.createProject(directory).id;
    const created = database.createSession(projectId, 'codex', directory);
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
        titleSource: nativeTitle === 'Analyze image' ? 'automatic' : undefined,
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
        createLogger(join(directory, 'logs')),
    );
    const renames = new SessionRenameService(
        database,
        agents,
        coordinator,
        () => {},
        createLogger(join(directory, 'rename-logs')),
    );
    cleanups.push(async () => {
        coordinator.close();
        database.close();
        await flushLoggers();
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
        /**
         * Adds another Agent Session in the same Project, already bound to a provider Session so a completed turn on it
         * is eligible for automatic naming.
         */
        addSession: () => {
            const extra = database.createSession(projectId, 'codex', directory);
            const extraTerminalId = extra.terminal!.id;
            database.rebindAgentSession(extraTerminalId, 'codex', `agent-${extra.session.id}`);
            return { sessionId: extra.session.id, terminalId: extraTerminalId };
        },
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
    it('does not generate a title for an already named Codex thread', async () => {
        const f = await fixture();
        f.setNativeTitle('Fix streaming 404');
        const generate = vi.spyOn(f.agents, 'generateTitle');
        const service = new SessionAutoNamingService(
            f.database,
            f.agents,
            f.renames,
            { homeDirectory: f.directory, variables: {} },
            () => true,
            createLogger(join(f.directory, 'logs')),
        );
        try {
            service.observe({
                provider: 'codex',
                terminalId: f.terminalId,
                launchId: 'test-launch',
                phase: 'turnFinished',
                agentSessionId: f.target.agentSessionId,
            });
            await vi.waitFor(() =>
                expect(f.database.automaticSessionNaming(f.sessionId)?.status).toBe('stopped'),
            );
            expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Fix streaming 404');
            expect(generate).not.toHaveBeenCalled();
            f.setNativeTitle('Fix 404 retry');
            f.database.updateAgentMetadata(f.terminalId, f.snapshot());
            expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Fix 404 retry');
        } finally {
            await service.close();
        }
    });

    it('reports a sandbox conflict once and retries only after a new launch', async () => {
        const f = await fixture();
        vi.useFakeTimers();
        vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
            baseRoot: f.directory,
            root: f.directory,
            path: join(f.directory, 'fixture.jsonl'),
        });
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
            opening: [
                { role: 'user', text: 'Fixture request' },
                { role: 'assistant', text: 'Fixture reply' },
            ],
            recent: [],
        });
        const generate = vi.spyOn(f.agents, 'generateTitle').mockRejectedValue(
            new CaxriError('UNAVAILABLE', 'Fixture sandbox conflict', {
                reason: 'sandboxBoundaryConflict',
            }),
        );
        const notice = vi.fn();
        const logger = createLogger(join(f.directory, 'logs'));
        const service = new SessionAutoNamingService(
            f.database,
            f.agents,
            f.renames,
            { homeDirectory: f.directory, variables: {} },
            () => true,
            logger,
            notice,
        );
        const event = {
            provider: 'codex' as const,
            terminalId: f.terminalId,
            launchId: 'first',
            phase: 'turnFinished' as const,
            agentSessionId: f.target.agentSessionId,
        };
        try {
            service.observe(event);
            await vi.waitFor(() => expect(notice).toHaveBeenCalledOnce());
            service.observe(event);
            await vi.advanceTimersByTimeAsync(120_000);
            service.observe(event);
            expect(generate).toHaveBeenCalledOnce();
            expect(notice).toHaveBeenCalledWith({
                launchId: 'first',
                reason: 'sandboxBoundaryConflict',
                sessionId: f.sessionId,
            });
            service.observe({ ...event, launchId: 'second' });
            await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
        } finally {
            await service.close();
            await logger.flush();
            vi.useRealTimers();
        }
    });

    it('retains a useful completed turn received during the insufficient-context cooldown', async () => {
        const f = await fixture();
        vi.useFakeTimers();
        vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
            baseRoot: f.directory,
            root: f.directory,
            path: join(f.directory, 'fixture.jsonl'),
        });
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
            opening: [
                { role: 'user', text: 'Fix title synchronization' },
                { role: 'assistant', text: 'The native title precedence was wrong' },
            ],
            recent: [],
        });
        const generate = vi
            .spyOn(f.agents, 'generateTitle')
            .mockResolvedValueOnce('SKIP')
            .mockResolvedValue('Concrete task title');
        const logger = createLogger(join(f.directory, 'logs'));
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
            const namingOptions = () =>
                log.mock.calls
                    .filter((call) => call[1] === logEventCatalog.agent.automaticNamingFinished)
                    .map((call) => call[2]);
            expect(namingOptions()[0]).toEqual({
                durationMs: expect.any(Number) as number,
                fields: {
                    provider: 'codex',
                    reason: 'insufficientContext',
                    sessionId: f.sessionId,
                },
            });
            service.observe(event);
            expect(generate).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(f.database.getSession(f.sessionId)?.displayTitle).toBe('Concrete task title');
            expect(f.rename).toHaveBeenCalledOnce();
            expect(namingOptions().at(-1)).toEqual({
                durationMs: expect.any(Number) as number,
                fields: {
                    provider: 'codex',
                    reason: 'completed',
                    retryDeferredCount: 1,
                    sessionId: f.sessionId,
                },
            });
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
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
            opening: [
                { role: 'user', text: 'Fix title synchronization' },
                { role: 'assistant', text: 'The native title precedence was wrong' },
            ],
            recent: [],
        });
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
            createLogger(join(f.directory, 'logs')),
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
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
            opening: [
                { role: 'user', text: 'Fix title synchronization' },
                { role: 'assistant', text: 'The native title precedence was wrong' },
            ],
            recent: [],
        });
        const generation = Promise.withResolvers<string>();
        const generate = vi.spyOn(f.agents, 'generateTitle').mockReturnValue(generation.promise);
        const logger = createLogger(join(f.directory, 'logs'));
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

    it('aborts forgotten naming, drops deferred work, and releases a semaphore slot', async () => {
        const f = await fixture();
        const second = f.addSession();
        const third = f.addSession();
        vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
            baseRoot: f.directory,
            root: f.directory,
            path: join(f.directory, 'fixture.jsonl'),
        });
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
            opening: [
                { role: 'user', text: 'Fix title synchronization' },
                { role: 'assistant', text: 'The native title precedence was wrong' },
            ],
            recent: [],
        });
        const generations: Array<{
            resolve: (title: string) => void;
            signal: AbortSignal | undefined;
        }> = [];
        const generate = vi.spyOn(f.agents, 'generateTitle').mockImplementation(
            (_provider, options) =>
                new Promise<string>((resolve) => {
                    options.signal?.addEventListener(
                        'abort',
                        () => resolve('Stale forgotten title'),
                        { once: true },
                    );
                    generations.push({ resolve, signal: options.signal });
                }),
        );
        const service = new SessionAutoNamingService(
            f.database,
            f.agents,
            f.renames,
            { homeDirectory: f.directory, variables: {} },
            () => true,
            createLogger(join(f.directory, 'logs')),
        );
        const event = (terminalId: string) => ({
            provider: 'codex' as const,
            terminalId,
            launchId: 'deletion-launch',
            phase: 'turnFinished' as const,
            agentSessionId: f.database.getTerminal(terminalId)?.agentSessionId ?? '',
        });

        try {
            service.observe(event(f.terminalId));
            service.observe(event(second.terminalId));
            service.observe(event(third.terminalId));
            await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));

            // A later turn is deferred behind the in-flight generation and must disappear with its Session.
            service.observe(event(f.terminalId));
            service.forgetSession(f.sessionId);
            expect(generations[0]?.signal?.aborted).toBe(true);
            f.database.deleteSession(f.sessionId);

            // The aborted generation releases one of the two slots, so the queued third Session can start.
            await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
            expect(f.database.getSession(f.sessionId)).toBeUndefined();
            expect(f.renames.revision(f.sessionId)).toBe(0);

            for (const generation of generations)
                if (!generation.signal?.aborted) generation.resolve('Current task title');
            await service.close();
            expect(f.database.getSession(f.sessionId)).toBeUndefined();
        } finally {
            for (const generation of generations)
                if (!generation.signal?.aborted) generation.resolve('Current task title');
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
            createLogger(join(f.directory, 'reopened-logs')),
        );
        try {
            const renames = new SessionRenameService(
                reopened,
                f.agents,
                coordinator,
                () => {},
                createLogger(join(f.directory, 'rename-logs')),
            );
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

/**
 * Suppression records the service keeps before it starts discarding them, mirroring `SESSION_RECORD_CAPACITY` in
 * `session-auto-naming.ts`. Pinned here on purpose: the fault these tests cover is an eviction that forgets a launch
 * still in force, and raising the bound would hide it rather than fix it.
 */
const SUPPRESSION_CAPACITY = 128;

describe('Automatic Session naming sandbox suppression', () => {
    /**
     * Puts one Session's naming attempt into the suppressed state and resolves once the sandbox notice for it has been
     * delivered, so the caller can retire that Session and move to the next one without racing the service.
     */
    async function suppressionFixture(
        isCurrentLaunch: (terminalId: string, launchId: string) => boolean = () => true,
    ) {
        const f = await fixture();
        vi.spyOn(agentFunctions, 'locateAgentTranscript').mockResolvedValue({
            baseRoot: f.directory,
            root: f.directory,
            path: join(f.directory, 'fixture.jsonl'),
        });
        vi.spyOn(agentFunctions, 'readAgentTitleMessages').mockResolvedValue({
            opening: [
                { role: 'user', text: 'Fixture request' },
                { role: 'assistant', text: 'Fixture reply' },
            ],
            recent: [],
        });
        const generate = vi.spyOn(f.agents, 'generateTitle').mockRejectedValue(
            new CaxriError('UNAVAILABLE', 'Fixture sandbox conflict', {
                reason: 'sandboxBoundaryConflict',
            }),
        );
        let delivered = Promise.withResolvers<void>();
        const notice = vi.fn(() => delivered.resolve());
        const logger = createLogger(join(f.directory, 'logs'));
        const service = new SessionAutoNamingService(
            f.database,
            f.agents,
            f.renames,
            { homeDirectory: f.directory, variables: {} },
            isCurrentLaunch,
            logger,
            notice,
        );
        const turnFinished = (terminalId: string) =>
            ({
                provider: 'codex',
                terminalId,
                launchId: 'launch',
                phase: 'turnFinished',
                agentSessionId: f.database.getTerminal(terminalId)?.agentSessionId ?? '',
            }) as const;
        return {
            f,
            generate,
            notice,
            service,
            dispose: async (): Promise<void> => {
                await service.close();
                await logger.flush();
            },
            turnFinished,
            block: async (terminalId: string): Promise<void> => {
                delivered = Promise.withResolvers<void>();
                service.observe(turnFinished(terminalId));
                await delivered.promise;
            },
            /**
             * Lets a re-admitted attempt reach the provider, so a suppression that failed to hold is observable instead
             * of merely pending.
             */
            settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
        };
    }

    /**
     * The boundary the fault sat on. One live Session is suppressed first, so it holds the oldest record, and then
     * exactly enough Sessions are retired behind it to overflow the bound: archived ones, which keep their Terminals,
     * and deleted ones. Evicting by insertion order alone would forget the live launch here and ask the user about the
     * same unavailable sandbox again on its very next completed turn.
     */
    it('keeps a live launch suppressed while more Sessions than the bound retire behind it', async () => {
        const { f, generate, service, turnFinished, block, settle, dispose } =
            await suppressionFixture();
        try {
            await block(f.terminalId);
            for (let index = 0; index <= SUPPRESSION_CAPACITY; index += 1) {
                const retired = f.addSession();
                // Insertion order is the thing under test, so each suppression lands before the next Session exists.
                // eslint-disable-next-line no-await-in-loop
                await block(retired.terminalId);
                // Archiving keeps the Terminal, so only a limited number of Sessions can retire that way at once.
                if (index < 20) f.database.archiveSession(retired.sessionId);
                else f.database.deleteSession(retired.sessionId);
            }
            const attempts = generate.mock.calls.length;
            expect(attempts).toBe(SUPPRESSION_CAPACITY + 2);

            service.observe(turnFinished(f.terminalId));
            await settle();

            expect(generate).toHaveBeenCalledTimes(attempts);
        } finally {
            await dispose();
        }
    });

    /**
     * The reason a window that was closed when the failure happened can still show it. The live notice is transient, so
     * with no Renderer attached it is simply dropped; the replay list is what a reconnecting client reads instead.
     */
    it('offers a still-applicable suppression to a client that connects after the failure', async () => {
        const { f, service, block, dispose } = await suppressionFixture();
        try {
            await block(f.terminalId);

            expect(service.automaticNamingNotices()).toEqual([
                {
                    launchId: 'launch',
                    reason: 'sandboxBoundaryConflict',
                    sessionId: f.sessionId,
                },
            ]);
        } finally {
            await dispose();
        }
    });

    it('forgets a sandbox suppression before the Session is deleted', async () => {
        const { f, service, block, dispose, generate, turnFinished } = await suppressionFixture();
        try {
            await block(f.terminalId);
            expect(service.automaticNamingNotices()).toHaveLength(1);

            service.forgetSession(f.sessionId);
            expect(service.automaticNamingNotices()).toEqual([]);

            service.observe(turnFinished(f.terminalId));
            await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
        } finally {
            await dispose();
        }
    });

    it('stops offering a suppression once its launch has ended', async () => {
        const launch = { isCurrent: true };
        const { f, service, block, dispose } = await suppressionFixture(() => launch.isCurrent);
        try {
            await block(f.terminalId);
            expect(service.automaticNamingNotices()).toHaveLength(1);

            launch.isCurrent = false;

            expect(service.automaticNamingNotices()).toEqual([]);
        } finally {
            await dispose();
        }
    });

    it.each([
        {
            basis: 'archived',
            retire: (f: Awaited<ReturnType<typeof suppressionFixture>>['f']) =>
                f.database.archiveSession(f.sessionId),
        },
        {
            basis: 'deleted',
            retire: (f: Awaited<ReturnType<typeof suppressionFixture>>['f']) =>
                f.database.deleteSession(f.sessionId),
        },
    ])('stops offering a suppression whose Session was $basis', async ({ retire }) => {
        const { f, service, block, dispose } = await suppressionFixture();
        try {
            await block(f.terminalId);
            expect(service.automaticNamingNotices()).toHaveLength(1);

            retire(f);

            expect(service.automaticNamingNotices()).toEqual([]);
        } finally {
            await dispose();
        }
    });
});
