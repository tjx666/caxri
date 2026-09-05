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
import { autoNamingStages } from '../session-auto-naming-metrics';
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

function terminal(provider: AgentProvider = 'claude'): TerminalRecord {
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

function lifecycle(
    phase: AgentLifecycleSignal['phase'],
    provider: AgentProvider = 'claude',
): AgentLifecycleSignal {
    return { launchId, phase, provider, terminalId };
}

function enabledSettings(provider: AgentProvider = 'claude'): AppSettings {
    const settings = structuredClone(defaultAppSettings);
    const providerSettings: AgentProviderSettings = settings['agents.providers'][provider];
    providerSettings.hooks.enabled = true;
    providerSettings.naming.enabled = true;
    return settings;
}

interface NamingRecord {
    durationMs?: number;
    fields: Record<string, string | number>;
    level: string;
}

/**
 * The complete `logger.write` calls for `agent.auto_naming_*`, in write order. Nothing is projected away, so a privacy
 * assertion over these also covers `context`, `failure`, and any option a later change starts passing.
 */
function namingCalls(loggerWrite: { mock: { calls: unknown[][] } }): unknown[][] {
    return loggerWrite.mock.calls.filter((call) => String(call[1]).startsWith('agent.auto_naming'));
}

/**
 * Reads the `agent.auto_naming_*` records a test produced, in write order.
 */
function namingRecords(loggerWrite: { mock: { calls: unknown[][] } }): NamingRecord[] {
    return namingCalls(loggerWrite).map((call) => {
        const options = call[2] as {
            durationMs?: number;
            fields: Record<string, string | number>;
        };
        return {
            durationMs: options.durationMs,
            fields: options.fields,
            level: String(call[0]),
        };
    });
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
        provider?: AgentProvider;
    } = {},
) {
    const provider = options.provider ?? 'claude';
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
                : Promise.resolve('Session naming lifecycle'),
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
        getTerminal: (id: string) => (id === terminalId ? terminal(provider) : undefined),
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
    const settings = enabledSettings(provider);
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
        expect(test.generateSessionTitle.mock.calls[0][0]).toBe('claude');
        expect(generationContext.cwd).toBe('/project');
        expect(generationContext.prompt).toContain('A private user request');
        expect(test.renameAutomatically).toHaveBeenCalledWith(
            sessionId,
            'Session naming lifecycle',
            expect.any(Function),
            expect.any(AbortSignal),
            expect.any(Function),
        );
        expect(
            JSON.stringify({ events: test.events, logs: test.loggerWrite.mock.calls }),
        ).not.toContain('A private');
        await test.service.close();
    });

    it('does not generate from a child-scoped completion', async () => {
        const test = harness();

        test.service.observe({ ...lifecycle('turnFinished'), agentId: 'subagent-1' });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(test.readTitleSource).not.toHaveBeenCalled();
        expect(test.generateSessionTitle).not.toHaveBeenCalled();
        expect(test.renameAutomatically).not.toHaveBeenCalled();
        await test.service.close();
    });

    it('does not start a Caxri generation for a provider with native naming', async () => {
        const test = harness({ provider: 'codex' });

        test.service.observe(lifecycle('turnFinished', 'codex'));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(test.readTitleSource).not.toHaveBeenCalled();
        expect(test.generateSessionTitle).not.toHaveBeenCalled();
        expect(test.renameAutomatically).not.toHaveBeenCalled();
        await test.service.close();
    });

    it('stops when a provider-native manual title replaces Caxri ownership', async () => {
        const test = harness({
            currentSource: titleSource({
                currentProviderTitle: 'Manual provider title',
                providerTitleState: 'explicit',
            }),
            ownership: { state: 'active', lastAutoTitle: 'Previous automatic title' },
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
        generation.resolve('Stale title');

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
        expect(serialized).toContain('claude');
        expect(serialized).toContain('Error');
        expect(serialized).not.toContain('private model detail');
        expect(namingRecords(test.loggerWrite)[0]).toMatchObject({
            fields: {
                attempt: 1,
                errorKind: 'Error',
                provider: 'claude',
                stage: 'providerGeneration',
            },
            level: 'warn',
        });
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

    it('rejects Resume when the provider owns automatic naming', async () => {
        const test = harness({
            currentSession: session({
                autoNamingState: 'stopped',
                displayTitle: 'Manual baseline',
                titleMode: 'manual',
            }),
            provider: 'codex',
        });

        await expect(test.service.resumeSession(sessionId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(test.resumeAutomaticSessionNaming).not.toHaveBeenCalled();
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
                currentProviderTitle: 'Previous automatic title',
                providerTitleState: 'explicit',
            }),
            currentOwnership: {
                currentProviderTitle: 'Previous automatic title',
                providerTitleState: 'explicit',
            },
            generate: () => generation.promise,
            ownership: { state: 'active', lastAutoTitle: 'Previous automatic title' },
        });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.setCurrentOwnership({
            currentProviderTitle: 'Manual provider title',
            providerTitleState: 'explicit',
        });
        generation.resolve('Generated too late');

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
        generation.resolve('Stale launch title');

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(test.renameAutomatically).not.toHaveBeenCalled();
        await test.service.close();
    });

    it('cancels generation immediately when Lifecycle hooks are disabled', async () => {
        const generation = Promise.withResolvers<string>();
        const test = harness({ generate: () => generation.promise });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.settings['agents.providers'].claude.hooks.enabled = false;
        test.service.reconcile(test.settings['agents.providers']);

        expect(test.generateSessionTitle.mock.calls[0][1].signal?.aborted).toBe(true);
        generation.resolve('Disabled result');
        await test.service.close();
        expect(test.renameAutomatically).not.toHaveBeenCalled();
    });

    it('records every stage it entered, with a duration and a bounded outcome', async () => {
        let now = 1_000;
        const test = harness({ now: () => (now += 10) });

        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(1));
        const [record] = namingRecords(test.loggerWrite);
        expect(record.level).toBe('info');
        expect(record.durationMs).toBeGreaterThan(0);
        expect(record.fields).toMatchObject({
            attempt: 1,
            outcome: 'renamed',
            provider: 'claude',
            reason: 'completed',
            stage: 'complete',
        });
        const measured = autoNamingStages.filter(
            (stage) => `${stage}Ms` in record.fields && stage !== 'complete',
        );
        expect(measured).toEqual([
            'queued',
            'sourceRead',
            'ownershipCheck',
            'branchRead',
            'providerGeneration',
            'rename',
        ]);
        for (const stage of measured) expect(record.fields[`${stage}Ms`]).toBeGreaterThan(0);
        await test.service.close();
    });

    it('names the gate that stopped an attempt before any provider read', async () => {
        let now = 1_000;
        const test = harness({ now: () => now });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.renameAutomatically).toHaveBeenCalledOnce());

        now += 1_000;
        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(2));
        expect(namingRecords(test.loggerWrite)[1]).toMatchObject({
            fields: { attempt: 2, outcome: 'skipped', reason: 'minimumInterval', stage: 'queued' },
            level: 'debug',
        });
        expect(test.readTitleSource).toHaveBeenCalledOnce();
        await test.service.close();
    });

    it('classifies a superseded generation apart from a cancelled one', async () => {
        const generation = Promise.withResolvers<string>();
        const test = harness({ generate: () => generation.promise });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.service.observe(lifecycle('turnStarted'));
        generation.resolve('Stale title');

        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(1));
        expect(namingRecords(test.loggerWrite)[0].fields).toMatchObject({
            outcome: 'superseded',
            reason: 'supersededByNewerTrigger',
            stage: 'providerGeneration',
        });
        await test.service.close();
    });

    /**
     * `slot.lastAttemptAt` is only stamped once an attempt reaches generation, so a Session blocked before that point
     * retries in full on every completed turn. Without the explicit per-Session throttle those records would be
     * unbounded at `info` (issue #504).
     */
    it('keeps at most one info record per Session per minute', async () => {
        let now = 1_000;
        const test = harness({
            currentSource: titleSource({
                currentProviderTitle: 'Manual provider title',
                providerTitleState: 'explicit',
            }),
            now: () => now,
            ownership: { state: 'active', lastAutoTitle: 'Previous automatic title' },
        });

        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(1));
        now += 1_000;
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(2));

        const records = namingRecords(test.loggerWrite);
        expect(records[0]).toMatchObject({
            fields: {
                outcome: 'blocked',
                reason: 'providerTitleExplicit',
                stage: 'ownershipCheck',
            },
            level: 'info',
        });
        expect(records[1].level).toBe('debug');
        expect(records[1].fields.reason).toBe('providerTitleExplicit');
        expect(records[0].fields).not.toHaveProperty('branchReadMs');
        expect(records[0].fields).not.toHaveProperty('providerGenerationMs');
        expect(records[0].fields).not.toHaveProperty('renameMs');
        expect(test.generateSessionTitle).not.toHaveBeenCalled();
        await test.service.close();
    });

    /**
     * Server Core's sink runs at `info`, so a downgraded record is dropped rather than deprioritized. The counts have
     * to survive on the next record that does reach `info` or a Session that keeps failing the same gate leaves the
     * production log empty (issue #504).
     */
    it('carries the per-Session reason counts on the record that reaches info', async () => {
        let now = 1_000;
        const test = harness({ now: () => now });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(1));
        now += 1_000;
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(2));

        // Past `MINIMUM_GENERATION_INTERVAL_MS`, so the interval gate and the info throttle both reopen.
        now += 61_000;
        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(3));
        const records = namingRecords(test.loggerWrite);
        expect(records[1].level).toBe('debug');
        expect(records[1].fields).not.toHaveProperty('reasonMinimumInterval');
        expect(records[2]).toMatchObject({
            fields: {
                reason: 'transcriptGrowthBelowThreshold',
                reasonCompleted: 1,
                reasonMinimumInterval: 1,
                reasonTranscriptGrowthBelowThreshold: 1,
                slowestAttemptMs: 0,
            },
            level: 'info',
        });
        await test.service.close();
    });

    it('keeps a high-frequency reason at debug even when the info budget is free', async () => {
        let now = 1_000;
        const test = harness({
            generate: () => Promise.reject(new Error('private model detail')),
            now: () => now,
        });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(namingCalls(test.loggerWrite)).toHaveLength(1));

        now += 1_000;
        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(namingCalls(test.loggerWrite)).toHaveLength(2));
        const records = namingRecords(test.loggerWrite);
        expect(records[0].level).toBe('warn');
        expect(records[1]).toMatchObject({
            fields: { outcome: 'skipped', reason: 'failureCooldown' },
            level: 'debug',
        });
        await test.service.close();
    });

    it('records a cancelled attempt that already spent generation time', async () => {
        const generation = Promise.withResolvers<string>();
        const test = harness({
            generate: async (context) => {
                context.signal?.addEventListener(
                    'abort',
                    () => generation.reject(new Error('aborted by caller')),
                    { once: true },
                );
                return generation.promise;
            },
        });
        test.service.observe(lifecycle('turnFinished'));
        await vi.waitFor(() => expect(test.generateSessionTitle).toHaveBeenCalledOnce());

        test.service.pauseSession(sessionId);

        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(1));
        expect(namingRecords(test.loggerWrite)[0].fields).toMatchObject({
            outcome: 'cancelled',
            reason: 'aborted',
            stage: 'providerGeneration',
        });
        await test.service.close();
        expect(test.renameAutomatically).not.toHaveBeenCalled();
    });

    it('keeps prompts, titles, transcripts and paths out of every naming record', async () => {
        const test = harness({
            currentSource: titleSource({ gitBranch: 'feat/private-branch' }),
            generate: () => Promise.resolve('Private generated title'),
        });

        test.service.observe(lifecycle('turnFinished'));

        await vi.waitFor(() => expect(namingRecords(test.loggerWrite)).toHaveLength(1));
        const serialized = JSON.stringify(namingCalls(test.loggerWrite));
        expect(serialized).not.toContain('A private');
        expect(serialized).not.toContain('Private generated title');
        expect(serialized).not.toContain('feat/private-branch');
        expect(serialized).not.toContain('/project');
        await test.service.close();
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
                                resolve('Aborted title');
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
