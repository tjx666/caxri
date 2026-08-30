import type {
    AgentProvider,
    AgentProviderSettings,
    AppSettings,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentLifecycleSignal, AgentService } from '../agents';
import type { AgentTitleSource } from '../agents/contract';
import type { CaxriDatabase } from '../db';
import { SessionAutoNamingService } from '../session-auto-naming';
import type { SessionRenameService } from '../session-rename';

const sessionId = 'session-1';
const terminalId = 'terminal-1';
const launchId = 'launch-1';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: sessionId,
        projectId: 'project-1',
        workbenchProjectId: 'project-1',
        rootPath: '/project',
        createdAt: 1,
        lastOpenedAt: 1,
        lastSessionActivityAt: 1,
        lastSessionActivityReason: 'created',
        primaryAgentTerminalId: terminalId,
        lastActivityState: 'completed',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        layoutVersion: 2,
        displayTitle: 'Untitled',
        titleMode: 'automatic',
        autoNamingState: 'active',
        ...overrides,
    };
}

function terminal(provider: AgentProvider = 'codex'): TerminalRecord {
    return {
        id: terminalId,
        sessionId,
        kind: provider,
        provider,
        cwd: '/project',
        title: 'Agent',
        icon: provider,
        orderIndex: 0,
        agentSessionId: 'agent-session-1',
        lastProcessState: 'running',
        createdAt: 1,
        updatedAt: 1,
    };
}

function titleSource(overrides: Partial<AgentTitleSource> = {}): AgentTitleSource {
    return {
        assistantMessages: ['A private assistant summary'],
        byteLength: 2_048,
        gitBranch: 'feat/session-naming',
        providerTitleState: 'absent',
        userMessages: ['A private user request'],
        ...overrides,
    };
}

function lifecycle(phase: AgentLifecycleSignal['phase']): AgentLifecycleSignal {
    return { launchId, phase, provider: 'codex', terminalId };
}

function enabledSettings(): AppSettings {
    const settings = structuredClone(defaultAppSettings);
    const provider: AgentProviderSettings = settings['agents.providers'].codex;
    provider.hooks.enabled = true;
    provider.naming.enabled = true;
    return settings;
}

function harness(
    options: {
        currentSession?: SessionRecord;
        currentOwnership?: Pick<AgentTitleSource, 'currentProviderTitle' | 'providerTitleState'>;
        currentSource?: AgentTitleSource;
        generate?: (
            context: Parameters<AgentService['generateSessionTitle']>[1],
        ) => Promise<string>;
        now?: () => number;
        ownership?: { lastAutoTitle?: string; state: 'active' | 'stopped' };
    } = {},
) {
    let currentSession = options.currentSession ?? session();
    let ownership = options.ownership ?? { state: 'active' as const };
    const source = options.currentSource ?? titleSource();
    let currentOwnership = options.currentOwnership ?? {
        currentProviderTitle: source.currentProviderTitle,
        providerTitleState: source.providerTitleState,
    };
    let isCurrentLaunch = true;
    const events: ServerEvent[] = [];
    const readTitleSource = vi.fn<AgentService['readTitleSource']>(() => Promise.resolve(source));
    const generateSessionTitle = vi.fn<AgentService['generateSessionTitle']>(
        (_provider, context) =>
            options.generate
                ? options.generate(context)
                : Promise.resolve('🧭 Session naming lifecycle'),
    );
    const readTitleOwnership = vi.fn<AgentService['readTitleOwnership']>(() =>
        Promise.resolve(currentOwnership),
    );
    const renameAutomatically = vi.fn(
        async (
            _sessionId: string,
            title: string,
            appGuard: () => boolean, // eslint-disable-line unicorn/consistent-boolean-name -- predicate callback
            _signal?: AbortSignal,
            ownershipGuard?: () => Promise<boolean>, // eslint-disable-line unicorn/consistent-boolean-name -- predicate callback
        ) => {
            if (!appGuard()) return;
            if (ownershipGuard && !(await ownershipGuard())) return;
            ownership = { state: 'active', lastAutoTitle: title };
            return title;
        },
    );
    const stopAutomaticSessionNaming = vi.fn(() => {
        ownership = { ...ownership, state: 'stopped' };
        currentSession = { ...currentSession, autoNamingState: 'stopped' };
        return currentSession;
    });
    const resumeAutomaticSessionNaming = vi.fn(
        async (_sessionId: string, appGuard: () => boolean | Promise<boolean> = () => true) => {
            if (!(await appGuard())) return;
            ownership = {
                state: 'active',
                lastAutoTitle:
                    currentSession.displayTitle === 'Untitled'
                        ? undefined
                        : currentSession.displayTitle,
            };
            currentSession = {
                ...currentSession,
                autoNamingState: 'active',
                titleMode: 'automatic',
            };
            return currentSession;
        },
    );
    const loggerWrite = vi.fn();
    const logger = { write: loggerWrite } as unknown as StructuredLogger;
    const database = {
        getSession: (id: string) => (id === sessionId ? currentSession : undefined),
        getTerminal: (id: string) => (id === terminalId ? terminal() : undefined),
        sessionNaming: {
            get: () => ownership,
            recordAutomaticTitle: vi.fn(),
            resume: resumeAutomaticSessionNaming,
            stop: stopAutomaticSessionNaming,
        },
    } as unknown as CaxriDatabase;
    const agents = {
        generateSessionTitle,
        readTitleOwnership,
        readTitleSource,
    } as unknown as AgentService;
    const renames = {
        renameAutomatically,
        resumeAutomaticNaming: resumeAutomaticSessionNaming,
    } as unknown as SessionRenameService;
    const settings = enabledSettings();
    const service = new SessionAutoNamingService(
        database,
        agents,
        renames,
        () => settings,
        (event) => events.push(event),
        logger,
        {
            hasForeignHookConflict: () => false,
            isCurrentLaunch: () => isCurrentLaunch,
            now: options.now,
        },
    );
    return {
        events,
        generateSessionTitle,
        loggerWrite,
        readTitleSource,
        readTitleOwnership,
        renameAutomatically,
        resumeAutomaticSessionNaming,
        service,
        setCurrentLaunch(isCurrent: boolean): void {
            isCurrentLaunch = isCurrent;
        },
        setCurrentOwnership(
            value: Pick<AgentTitleSource, 'currentProviderTitle' | 'providerTitleState'>,
        ): void {
            currentOwnership = value;
        },
        settings,
        stopAutomaticSessionNaming,
    };
}

describe('Session automatic naming', () => {
    beforeEach(() => vi.useRealTimers());

    it('generates after a completed turn and keeps transcript text out of events and logs', async () => {
        const test = harness();

        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(test.renameAutomatically).toHaveBeenCalledOnce());
        const generationContext = test.generateSessionTitle.mock.calls[0][1];
        expect(test.generateSessionTitle.mock.calls[0][0]).toBe('codex');
        expect(generationContext.cwd).toBe('/project');
        expect(generationContext.prompt).toContain('A private user request');
        expect(test.renameAutomatically).toHaveBeenCalledWith(
            sessionId,
            '🧭 Session naming lifecycle',
            expect.any(Function),
            expect.any(AbortSignal),
            expect.any(Function),
        );
        expect(
            JSON.stringify({ events: test.events, logs: test.loggerWrite.mock.calls }),
        ).not.toContain('A private');
        await test.service.close();
    });

    it('stops when a provider-native manual title replaces Caxri ownership', async () => {
        const test = harness({
            currentSource: titleSource({
                currentProviderTitle: 'Manual provider title',
                providerTitleState: 'explicit',
            }),
            ownership: { state: 'active', lastAutoTitle: '🧭 Previous automatic title' },
        });

        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() =>
            expect(test.stopAutomaticSessionNaming).toHaveBeenCalledWith(sessionId),
        );
        expect(test.generateSessionTitle).not.toHaveBeenCalled();
        expect(test.events).toContainEqual({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
        });
        await test.service.close();
    });

    it('invalidates an in-flight generation when the next turn starts', async () => {
        const generation = Promise.withResolvers<string>();
        const test = harness({ generate: () => generation.promise });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.service.observe(lifecycle('turnStarted'));
        generation.resolve('🧯 Stale title');

        await vi.waitFor(() =>
            expect(test.generateSessionTitle.mock.calls[0]?.[1].signal?.aborted).toBe(true),
        );
        expect(test.renameAutomatically).not.toHaveBeenCalled();
        await test.service.close();
    });

    it('throttles repeated completions without enough time or transcript growth', async () => {
        let now = 1_000;
        const test = harness({ now: () => now });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        now += 1_000;
        test.service.observe(lifecycle('turnFinished'));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(test.generateSessionTitle).toHaveBeenCalledOnce();
        expect(test.readTitleSource).toHaveBeenCalledOnce();
        await test.service.close();
    });

    it('logs only an error class and provider when generation fails', async () => {
        const test = harness({ generate: () => Promise.reject(new Error('private model detail')) });

        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(test.loggerWrite).toHaveBeenCalledOnce());
        const serialized = JSON.stringify(test.loggerWrite.mock.calls);
        expect(serialized).toContain('codex');
        expect(serialized).toContain('Error');
        expect(serialized).not.toContain('private model detail');
        await test.service.close();
    });

    it('resumes from the persisted Session title without a stale provider read', async () => {
        const test = harness({
            currentSession: session({
                autoNamingState: 'stopped',
                displayTitle: 'Manual baseline',
                titleMode: 'manual',
            }),
            ownership: { state: 'stopped' },
        });

        await expect(test.service.resumeSession(sessionId)).resolves.toMatchObject({
            autoNamingState: 'active',
            titleMode: 'automatic',
        });
        expect(test.resumeAutomaticSessionNaming).toHaveBeenCalledWith(sessionId);
        expect(test.readTitleSource).not.toHaveBeenCalled();
        expect(test.readTitleOwnership).not.toHaveBeenCalled();
        await test.service.close();
    });

    it('fails closed when provider title ownership cannot be verified', async () => {
        const test = harness({
            currentSource: titleSource({ providerTitleState: 'unknown' }),
        });

        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(test.readTitleSource).toHaveBeenCalledOnce());
        expect(test.generateSessionTitle).not.toHaveBeenCalled();
        await test.service.close();
    });

    it('lets a provider-native manual rename during generation win', async () => {
        const generation = Promise.withResolvers<string>();
        const test = harness({
            currentSource: titleSource({
                currentProviderTitle: '🧭 Previous automatic title',
                providerTitleState: 'explicit',
            }),
            currentOwnership: {
                currentProviderTitle: '🧭 Previous automatic title',
                providerTitleState: 'explicit',
            },
            generate: () => generation.promise,
            ownership: { state: 'active', lastAutoTitle: '🧭 Previous automatic title' },
        });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.setCurrentOwnership({
            currentProviderTitle: 'Manual provider title',
            providerTitleState: 'explicit',
        });
        generation.resolve('🧭 Generated too late');

        await vi.waitFor(() =>
            expect(test.stopAutomaticSessionNaming).toHaveBeenCalledWith(sessionId),
        );
        expect(test.renameAutomatically).toHaveBeenCalledOnce();
        await test.service.close();
    });

    it('drops a generated title after the PTY launch identity changes', async () => {
        const generation = Promise.withResolvers<string>();
        const test = harness({ generate: () => generation.promise });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.setCurrentLaunch(false);
        generation.resolve('🧯 Stale launch title');

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(test.renameAutomatically).not.toHaveBeenCalled();
        await test.service.close();
    });

    it('cancels generation immediately when Lifecycle hooks are disabled', async () => {
        const generation = Promise.withResolvers<string>();
        const test = harness({ generate: () => generation.promise });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.settings['agents.providers'].codex.hooks.enabled = false;
        test.service.reconcile(test.settings['agents.providers']);

        expect(test.generateSessionTitle.mock.calls[0][1].signal?.aborted).toBe(true);
        generation.resolve('🧯 Disabled result');
        await test.service.close();
        expect(test.renameAutomatically).not.toHaveBeenCalled();
    });

    it('waits for aborted generation work to settle before shutdown completes', async () => {
        let isGenerationSettled = false;
        const test = harness({
            generate: (context) =>
                new Promise((resolve) => {
                    context.signal?.addEventListener(
                        'abort',
                        () => {
                            setTimeout(() => {
                                isGenerationSettled = true;
                                resolve('🧯 Aborted title');
                            }, 10);
                        },
                        { once: true },
                    );
                }),
        });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        const closing = test.service.close();
        expect(isGenerationSettled).toBe(false);
        await closing;

        expect(isGenerationSettled).toBe(true);
        expect(test.renameAutomatically).not.toHaveBeenCalled();
    });
});
