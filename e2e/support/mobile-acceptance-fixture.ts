import { Buffer } from 'node:buffer';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState, MobileTimelineReadResult } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import type { RunningCaxri } from './helpers';
import { createProjectSession, launchCaxri, pageRequest, sessionCard } from './helpers';
import {
    createSyntheticShell,
    fakeChatAgent,
    fakeFailingAgent,
    fakeWaitingAgent,
} from './mobile-acceptance-agents';
import type { MobileAgentChatDriver } from './mobile-agent-chat-driver';
import { createMobileAgentChatDriver } from './mobile-agent-chat-driver';
import {
    mobileSemantics,
    openMobilePairingLink,
    runMobileDeviceCommand,
    waitForMobile,
} from './mobile-android';
import type { AttentionCommand, AttentionReceipt } from './mobile-attention-fixture';
import {
    enableMobileAttentionHooks,
    mobileAttentionControl,
    prepareMobileAttentionAgent,
} from './mobile-attention-fixture';
import type { MobileChangesFixtureKind } from './mobile-changes-fixture';
import { seedMobileChangesFixture } from './mobile-changes-fixture';
import { fakeConversationAgent } from './mobile-conversation-agent-fixture';
import type { MobileEncryptedPeer } from './mobile-encrypted-peer';
import { pairMobileEncryptedPeer } from './mobile-encrypted-peer';
import type { SyntheticMenuState } from './mobile-synthetic-menu-state';
import { readSyntheticMenuState } from './mobile-synthetic-menu-state';

export interface MobileAcceptanceFixture {
    /**
     * The Chat Terminal of an `agent-chat` fixture, driven by the deterministic fake of its `chatProvider`.
     */
    agentChat?: MobileAgentChatDriver;
    allowedProjectId: string;
    allowedSessionId?: string;
    deniedProjectId: string;
    deniedSessionId?: string;
    inputCapture?: string;
    journey?: {
        conversationTerminalId: string;
        conversationMenuState(): Promise<SyntheticMenuState | null>;
        menuSessionId: string;
        menuTerminalId: string;
        menuState(): Promise<SyntheticMenuState>;
        seedChanges(kind?: MobileChangesFixtureKind): Promise<void>;
    };
    pair(): Promise<{ deviceId: string }>;
    pairFromDesktopUi(trigger: () => Promise<void>): Promise<{ deviceId: string }>;
    failNextAgentLaunch(): Promise<void>;
    readCapturedInput(): Promise<Buffer>;
    appendTranscript?(records: unknown[]): Promise<void>;
    attention?: {
        readReceipt(): Promise<AttentionReceipt[]>;
        trigger(command: AttentionCommand): Promise<void>;
    };
    pairTimelineGateway?(): Promise<MobileEncryptedPeer>;
    readTimeline?(): Promise<MobileTimelineReadResult>;
    shellGridStatePath?: string;
    replaceTranscript?(records: unknown[]): Promise<void>;
    running: RunningCaxri;
    stop(): Promise<void>;
    testDirectory: string;
}

interface CreateMobileAcceptanceFixtureInput {
    mode:
        | 'agent-chat'
        | 'empty'
        | 'waiting'
        | 'attention'
        | 'launch-failure'
        | 'conversation'
        | 'shell-conversation'
        | 'journey';
    serial: string;
    /**
     * The provider an `agent-chat` fixture opens its Chat with. Defaults to Codex.
     */
    chatProvider?: 'claude' | 'codex';
    /**
     * Scripted turns for the fake Claude (`fake-claude-script.ts`), played when the Chat sends a turn's prompt.
     */
    claudeScript?: FakeClaudeScript;
    /**
     * Writes synthetic files into the allowed Project root before Caxri launches, such as `seedMobileChangesFixture`
     * for Changes.
     */
    seedProject?: (root: string) => Promise<void>;
    /**
     * Extra launch environment, such as a `PATH` that puts a fake `gh` ahead of the host's.
     */
    env?: NodeJS.ProcessEnv;
    dropSubmitAcknowledgement?: boolean;
    delayPairingResult?: boolean;
    isolatedProjectHome?: boolean;
}

export async function createMobileAcceptanceFixture(
    input: CreateMobileAcceptanceFixtureInput,
): Promise<MobileAcceptanceFixture> {
    if (input.mode === 'journey' && input.seedProject)
        throw new Error('A journey seeds its Project after the synthetic Agent action');
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-acceptance-'));
    const userData = join(testDirectory, 'user-data');
    const allowedRoot = join(testDirectory, 'allowed-project');
    const deniedRoot = join(testDirectory, 'denied-project');
    const inputCapture = join(testDirectory, 'agent-input.bin');
    const claudeScriptPath = input.claudeScript
        ? join(testDirectory, 'claude-script.json')
        : undefined;
    if (claudeScriptPath) await writeFile(claudeScriptPath, JSON.stringify(input.claudeScript));
    const menuStatePath =
        input.mode === 'journey' ? join(testDirectory, 'codex-menu-state.json') : undefined;
    const conversationMenuStatePath =
        input.mode === 'journey' ? join(testDirectory, 'conversation-menu-state.json') : undefined;
    const shellGridStatePath =
        input.mode === 'shell-conversation'
            ? join(allowedRoot, '.caxri-synthetic-shell-state.json')
            : undefined;
    await Promise.all([
        mkdir(allowedRoot, { recursive: true }),
        mkdir(deniedRoot, { recursive: true }),
        ...(input.isolatedProjectHome
            ? [
                  mkdir(join(userData, 'e2e-agents', 'home', 'mobile-new-project', 'nested'), {
                      recursive: true,
                  }),
              ]
            : []),
    ]);
    if (input.seedProject) {
        try {
            await input.seedProject(allowedRoot);
        } catch (error) {
            await rm(testDirectory, { force: true, recursive: true });
            throw error;
        }
    }
    const conversationAgentMode =
        input.mode === 'conversation' || input.mode === 'journey'
            ? await fakeConversationAgent(
                  userData,
                  conversationMenuStatePath,
                  menuStatePath,
                  input.mode === 'journey' ? inputCapture : undefined,
              )
            : undefined;
    const attentionAgentMode =
        input.mode === 'attention' ? await prepareMobileAttentionAgent(userData) : undefined;
    const syntheticShell =
        input.mode === 'shell-conversation' ? await createSyntheticShell(testDirectory) : undefined;
    const agentMode =
        input.mode === 'waiting'
            ? await fakeWaitingAgent(userData, inputCapture)
            : attentionAgentMode && input.mode === 'attention'
              ? attentionAgentMode.agentMode
              : input.mode === 'launch-failure'
                ? await fakeFailingAgent(userData)
                : input.mode === 'agent-chat'
                  ? await fakeChatAgent(userData, testDirectory, claudeScriptPath)
                  : (conversationAgentMode ?? ({ mode: 'blocked' } as const));
    let running: RunningCaxri;
    try {
        running = await launchCaxri({
            agentMode,
            desktopLeaseWaitMs: process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID ? 180_000 : undefined,
            userDataDir: userData,
            testRootPath: allowedRoot,
            env: {
                ...input.env,
                ...(input.mode === 'waiting' && { CAXRI_E2E_AGENT_HOOKS: '1' }),
                ...(input.dropSubmitAcknowledgement && {
                    CAXRI_E2E_MOBILE_DROP_SUBMIT_ACK_ONCE: '1',
                }),
                ...(input.delayPairingResult && {
                    CAXRI_E2E_MOBILE_PAIRING_RESULT_DELAY: '1',
                }),
                CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host',
                CAXRI_TEST_ROOT_PATHS: JSON.stringify([allowedRoot, deniedRoot]),
                ...(input.mode === 'shell-conversation' && {
                    SHELL: syntheticShell,
                }),
            },
        });
    } catch (error) {
        await rm(testDirectory, { force: true, recursive: true });
        throw error;
    }
    let isStopped = false;
    const stop = async (): Promise<void> => {
        if (isStopped) return;
        isStopped = true;
        let failure: unknown;
        try {
            await pageRequest(running.page, 'mobile.access.disable');
        } catch {
            // Removing the isolated profile clears the remaining gateway and device state.
        }
        try {
            await running.app.close();
        } catch (error) {
            failure = error;
        }
        try {
            await waitForMobile(
                () => runMobileDeviceCommand('/bin/ps', ['-axo', 'pid=,args='], 'capture'),
                (processes) => processes.split('\n').every((line) => !line.includes(userData)),
            );
        } catch (error) {
            failure ??= error;
        }
        try {
            await rm(testDirectory, { force: true, recursive: true });
        } catch (error) {
            failure ??= error;
        }
        if (failure) throw failure instanceof Error ? failure : new Error('Fixture cleanup failed');
    };

    let allowedProjectId: string;
    let deniedProjectId: string;
    let allowedSessionId: string | undefined;
    let deniedSessionId: string | undefined;
    let menuSessionId: string | undefined;
    let menuTerminalId: string | undefined;
    let conversationTerminalId: string | undefined;
    let chatTerminalId: string | undefined;
    let transcriptPath: string | undefined;
    try {
        /**
         * Destructive Desktop requests still exercise their real Main-process routing, but their native confirmation
         * cannot be answered by Playwright. This fixture owns only disposable Projects, Sessions, and mobile devices.
         */
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ checkboxChecked: false, response: 0 });
        });
        if (['conversation', 'journey', 'attention'].includes(input.mode)) {
            if (input.mode === 'attention') await enableMobileAttentionHooks(running.page);
            allowedSessionId = await createProjectSession(running.page, 'claude');
            const bound = await waitForMobile(
                () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
                (state) =>
                    state.terminals.some(
                        (terminal) =>
                            terminal.sessionId === allowedSessionId &&
                            (input.mode === 'attention'
                                ? Boolean(terminal.agentSessionId)
                                : terminal.agentSessionId?.startsWith(
                                      'mobile-conversation-fixture-',
                                  )),
                    ),
            );
            const allowed = bound.sessions.find(({ id }) => id === allowedSessionId);
            const terminal = bound.terminals.find(
                ({ sessionId }) => sessionId === allowedSessionId,
            );
            const config =
                conversationAgentMode?.environment.CLAUDE_CONFIG_DIR ??
                attentionAgentMode?.agentMode.environment.CLAUDE_CONFIG_DIR;
            if (
                !allowed ||
                !terminal ||
                (input.mode !== 'attention' && (!config || !terminal.agentSessionId))
            )
                throw new Error('Synthetic Conversation binding is unavailable');
            conversationTerminalId = terminal.id;
            if (config && terminal.agentSessionId) {
                transcriptPath = join(
                    config,
                    'projects',
                    terminal.cwd.replaceAll(/[^a-z0-9]/giu, '-'),
                    `${terminal.agentSessionId}.jsonl`,
                );
                if (input.mode === 'attention') {
                    /**
                     * An empty fixture transcript enables Conversation without recording private Agent content.
                     */
                    await mkdir(dirname(transcriptPath), { recursive: true });
                    await writeFile(transcriptPath, '');
                }
            }
            if (input.mode === 'journey') {
                if (!menuStatePath) throw new Error('Synthetic Terminal state path is unavailable');
                const menu = await pageRequest<{
                    session: { id: string; projectId: string };
                    terminal: { id: string } | null;
                }>(running.page, 'session.create', {
                    projectId: allowed.projectId,
                    defaultAgent: 'codex',
                });
                if (menu.session.projectId !== allowed.projectId || !menu.terminal)
                    throw new Error('Synthetic Terminal must belong to the allowed Project');
                menuSessionId = menu.session.id;
                menuTerminalId = menu.terminal.id;
                await waitForMobile(
                    () => readSyntheticMenuState(menuStatePath),
                    (state) => state?.selected === 1 && state.submissions === 0,
                );
            }
            deniedSessionId = await createProjectSession(running.page, 'shell');
            const deniedState = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            const denied = deniedState.sessions.find(({ id }) => id === deniedSessionId);
            if (!denied) throw new Error('Denied fixture Project is unavailable');
            allowedProjectId = allowed.projectId;
            deniedProjectId = denied.projectId;
            if (input.mode === 'journey') {
                await pageRequest(running.page, 'session.select', { sessionId: allowedSessionId });
                await waitForMobile(
                    () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
                    (state) => state.selectedSessionId === allowedSessionId,
                );
                await waitForMobile(
                    () =>
                        sessionCard(running.page, allowedSessionId!).getAttribute('aria-selected'),
                    (selected) => selected === 'true',
                );
            }
        } else if (input.mode === 'agent-chat') {
            const placeholderSessionId = await createProjectSession(running.page, 'shell');
            const placeholderState = await pageRequest<BootstrapState>(
                running.page,
                'app.bootstrap',
            );
            const placeholder = placeholderState.sessions.find(
                ({ id }) => id === placeholderSessionId,
            );
            if (!placeholder) throw new Error('Allowed fixture Project is unavailable');
            const chat = await pageRequest<{
                session: { id: string; projectId: string };
                terminal: { id: string } | null;
            }>(running.page, 'session.create', {
                projectId: placeholder.projectId,
                defaultAgent: input.chatProvider ?? 'codex',
                surface: 'chat',
            });
            if (!chat.terminal) throw new Error('Synthetic Chat Terminal is unavailable');
            await pageRequest(running.page, 'session.delete', { sessionId: placeholderSessionId });
            allowedSessionId = chat.session.id;
            chatTerminalId = chat.terminal.id;
            deniedSessionId = await createProjectSession(running.page, 'shell');
            const deniedState = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            const denied = deniedState.sessions.find(({ id }) => id === deniedSessionId);
            if (!denied) throw new Error('Denied fixture Project is unavailable');
            allowedProjectId = placeholder.projectId;
            deniedProjectId = denied.projectId;
        } else if (input.mode === 'waiting') {
            const currentSettings = await pageRequest<{ value: AppSettings }>(
                running.page,
                'settings.get',
            );
            const settings = structuredClone(currentSettings.value);
            settings['agents.providers'].codex.hooks.enabled = true;
            await pageRequest(running.page, 'settings.update', {
                source: JSON.stringify(settings, null, 2),
            });
            allowedSessionId = await createProjectSession(running.page, 'codex');
            deniedSessionId = await createProjectSession(running.page, 'codex');
            const waiting = await waitForMobile(
                () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
                (state) =>
                    [allowedSessionId, deniedSessionId].every((sessionId) =>
                        state.sessions.some(
                            (session) =>
                                session.id === sessionId &&
                                session.agentActivityState === 'waiting' &&
                                session.attentionGeneration > 0,
                        ),
                    ),
            );
            const allowed = waiting.sessions.find(({ id }) => id === allowedSessionId);
            const denied = waiting.sessions.find(({ id }) => id === deniedSessionId);
            if (!allowed || !denied) throw new Error('Mobile Acceptance Sessions are unavailable');
            allowedProjectId = allowed.projectId;
            deniedProjectId = denied.projectId;
        } else {
            const allowedEmptySessionId = await createProjectSession(running.page, 'shell');
            const deniedEmptySessionId = await createProjectSession(running.page, 'shell');
            const emptyState = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            const allowed = emptyState.sessions.find(({ id }) => id === allowedEmptySessionId);
            const denied = emptyState.sessions.find(({ id }) => id === deniedEmptySessionId);
            if (!allowed || !denied) throw new Error('Mobile Acceptance Projects are unavailable');
            allowedProjectId = allowed.projectId;
            deniedProjectId = denied.projectId;
            if (input.mode === 'launch-failure' || input.mode === 'shell-conversation') {
                allowedSessionId = allowedEmptySessionId;
                deniedSessionId = deniedEmptySessionId;
            } else {
                await pageRequest(running.page, 'session.delete', {
                    sessionId: allowedEmptySessionId,
                });
                await pageRequest(running.page, 'session.delete', {
                    sessionId: deniedEmptySessionId,
                });
            }
        }
    } catch (error) {
        await stop();
        throw error;
    }

    const waitForPairedDevice = async (): Promise<{ deviceId: string }> => {
        const nodes = await waitForMobile(
            () => mobileSemantics(input.serial),
            (semantics) =>
                semantics.some(({ checkId }) =>
                    allowedSessionId
                        ? checkId === `session-row-${allowedSessionId}` ||
                          checkId === 'pairing-error'
                        : checkId === 'session-list-empty' || checkId === 'pairing-error',
                ),
        );
        if (nodes.some(({ checkId }) => checkId === 'pairing-error')) {
            throw new Error('Mobile Acceptance pairing failed');
        }
        if (
            deniedSessionId &&
            nodes.some(({ checkId }) => checkId === `session-row-${deniedSessionId}`)
        ) {
            throw new Error('The paired device exposed a Session outside its Project grant');
        }
        const devices = await pageRequest<{
            devices: Array<{ deviceId: string; revokedAt?: number }>;
        }>(running.page, 'mobile.device.list');
        const active = devices.devices.filter(({ revokedAt }) => revokedAt === undefined);
        if (active.length !== 1) throw new Error('Unexpected active paired-device count');
        return { deviceId: active[0].deviceId };
    };
    let isChangesSeeded = false;
    return {
        ...(chatTerminalId && {
            agentChat: createMobileAgentChatDriver(running.page, chatTerminalId),
        }),
        allowedProjectId,
        allowedSessionId,
        deniedProjectId,
        deniedSessionId,
        ...(menuSessionId &&
            menuTerminalId &&
            menuStatePath &&
            conversationTerminalId &&
            conversationMenuStatePath && {
                journey: {
                    conversationTerminalId,
                    conversationMenuState: () => readSyntheticMenuState(conversationMenuStatePath),
                    menuSessionId,
                    menuTerminalId,
                    menuState: async () => {
                        const state = await readSyntheticMenuState(menuStatePath);
                        if (!state) throw new Error('Synthetic Terminal menu state is unavailable');
                        return state;
                    },
                    seedChanges: async (kind: MobileChangesFixtureKind = 'standard') => {
                        if (isStopped) throw new Error('Journey fixture has already stopped');
                        if (isChangesSeeded) throw new Error('Journey Changes were already seeded');
                        const menu = await readSyntheticMenuState(conversationMenuStatePath);
                        if (!menu || menu.interrupts < 1 || menu.submissions < 1)
                            throw new Error('Synthetic Agent menu action must precede Changes');
                        await seedMobileChangesFixture(allowedRoot, kind);
                        isChangesSeeded = true;
                    },
                },
            }),
        ...((input.mode === 'waiting' || input.mode === 'journey') && { inputCapture }),
        ...(shellGridStatePath && { shellGridStatePath }),
        ...(input.mode === 'attention' &&
            attentionAgentMode &&
            conversationTerminalId && {
                attention: mobileAttentionControl(
                    running.page,
                    conversationTerminalId,
                    attentionAgentMode.receiptPath,
                ),
            }),
        ...(transcriptPath && {
            appendTranscript: async (records: unknown[]) => {
                await mkdir(dirname(transcriptPath), { recursive: true });
                await appendFile(
                    transcriptPath,
                    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
                );
            },
            replaceTranscript: async (records: unknown[]) => {
                const next = `${transcriptPath}.next`;
                await writeFile(
                    next,
                    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
                );
                await rename(next, transcriptPath);
            },
            readTimeline: async () => {
                const [{ CaxriDatabase }, { AgentTimelineService }] = await Promise.all([
                    import('../../apps/server/src/domains/db'),
                    import('../../apps/server/src/domains/agents/timeline'),
                ]);
                const database = new CaxriDatabase(join(userData, 'caxri.db'));
                try {
                    const session = database.getSession(allowedSessionId!);
                    if (!session?.primaryAgentTerminalId)
                        throw new Error('Synthetic Conversation primary Agent is unavailable');
                    if (!conversationAgentMode)
                        throw new Error('Synthetic Conversation Agent is unavailable');
                    const timeline = new AgentTimelineService(database, {
                        homeDirectory: testDirectory,
                        variables: conversationAgentMode.environment,
                    });
                    return await timeline.read(
                        session.id,
                        session.primaryAgentTerminalId,
                        undefined,
                        80,
                    );
                } finally {
                    database.close();
                }
            },
            pairTimelineGateway: async () => {
                const pairing = await pageRequest<{ pairingLink: string }>(
                    running.page,
                    'mobile.pairing.create',
                    { projectIds: [allowedProjectId] },
                );
                return pairMobileEncryptedPeer(pairing.pairingLink);
            },
        }),
        pair: async () => {
            await pageRequest(running.page, 'mobile.access.enable');
            const pairing = await pageRequest<{ pairingLink: string }>(
                running.page,
                'mobile.pairing.create',
                { projectIds: [allowedProjectId] },
            );
            await openMobilePairingLink(input.serial, pairing.pairingLink);
            return waitForPairedDevice();
        },
        pairFromDesktopUi: async (trigger) => {
            /**
             * Arm the one-shot preload bridge only after all pre-credential frames are frozen. The pairing link crosses
             * directly to ADB in memory and is discarded before any post-pairing capture starts.
             */
            await running.page.evaluate(() => {
                const acceptanceGlobal = globalThis as typeof globalThis & {
                    caxriE2E: { armMobilePairingBridge: () => void };
                };
                acceptanceGlobal.caxriE2E.armMobilePairingBridge();
            });
            await trigger();
            const pairingLink = await running.page.evaluate(() => {
                const acceptanceGlobal = globalThis as typeof globalThis & {
                    caxriE2E: { takeMobilePairingLink: () => Promise<string> };
                };
                return acceptanceGlobal.caxriE2E.takeMobilePairingLink();
            });
            await openMobilePairingLink(input.serial, pairingLink);
            return waitForPairedDevice();
        },
        readCapturedInput: async () => {
            if (input.mode !== 'waiting' && input.mode !== 'journey') return Buffer.alloc(0);
            try {
                return await readFile(inputCapture);
            } catch (error) {
                if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    error.code === 'ENOENT'
                )
                    return Buffer.alloc(0);
                throw error;
            }
        },
        failNextAgentLaunch: async () => {
            if (input.mode !== 'launch-failure')
                throw new Error('Agent launch failure is unavailable in this fixture');
            await rm(join(userData, 'e2e-agents', 'bin', 'codex'));
        },
        running,
        stop,
        testDirectory,
    };
}
