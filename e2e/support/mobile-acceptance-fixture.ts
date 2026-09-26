import { Buffer } from 'node:buffer';
import {
    appendFile,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState, MobileTimelineReadResult } from '@caxri/protocol';

import { createFakeAgentMode } from './agent-fixture';
import type { RunningCaxri } from './helpers';
import { createProjectSession, launchCaxri, pageRequest, sessionCard } from './helpers';
import {
    mobileSemantics,
    openMobilePairingLink,
    runMobileDeviceCommand,
    waitForMobile,
} from './mobile-android';
import type { MobileChangesFixtureKind } from './mobile-changes-fixture';
import { seedMobileChangesFixture } from './mobile-changes-fixture';
import type { MobileEncryptedPeer } from './mobile-encrypted-peer';
import { pairMobileEncryptedPeer } from './mobile-encrypted-peer';

export interface MobileAcceptanceFixture {
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
        'empty' | 'waiting' | 'launch-failure' | 'conversation' | 'shell-conversation' | 'journey';
    serial: string;
    changes?: MobileChangesFixtureKind;
    dropSubmitAcknowledgement?: boolean;
    delayPairingResult?: boolean;
    isolatedProjectHome?: boolean;
}

const MOBILE_ACCEPTANCE_SAFE_OUTPUT = 'Synthetic Agent output: ready for Acceptance review.\r\n';

interface SyntheticMenuState {
    cols: number | null;
    firstGridMarker: { columns: number; generation: string; rows: number };
    generation: string;
    interrupts: number;
    lines: string[];
    phase: 'busy' | 'menu';
    rows: number | null;
    selected: number;
    submissions: number;
}

async function readSyntheticMenuState(path: string): Promise<SyntheticMenuState | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as SyntheticMenuState;
    } catch (error) {
        if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return null;
        throw error;
    }
}

async function fakeWaitingAgent(userDataDirectory: string, inputCapture: string) {
    return createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
function invokeHook(event, payload) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify(payload),
  });
}
let resumed = false;
const fixtureSessionId = 'mobile-acceptance-session-' + process.pid;
process.stdin.setRawMode?.(true);
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(${JSON.stringify(inputCapture)}, chunk);
  if (chunk.includes(3)) process.exit(130);
  if (!resumed) {
    resumed = true;
    invokeHook('UserPromptSubmit', { session_id: fixtureSessionId, turn_id: 'turn-2' });
  }
  if (chunk.includes(13)) process.stdout.write('Synthetic message received.\r\n');
});
process.stdin.resume();
process.stdout.write(${JSON.stringify(MOBILE_ACCEPTANCE_SAFE_OUTPUT)});
setTimeout(() => {
  invokeHook('UserPromptSubmit', { session_id: fixtureSessionId, turn_id: 'turn-1' });
  invokeHook('PermissionRequest', { session_id: fixtureSessionId, turn_id: 'turn-1' });
}, 500);
`,
            },
        },
    });
}

async function fakeFailingAgent(userDataDirectory: string) {
    return createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
process.stderr.write('Synthetic Agent launch failed.\n');
process.exit(7);
`,
            },
        },
    });
}

/**
 * The marker is written only after raw input and the menu renderer are ready.
 */
function syntheticMenuControllerSource(statePath: string): string {
    return String.raw`let menuActive = false;
let selected = 1;
let submissions = 0;
let interrupts = 0;
let pending = Buffer.alloc(0);
let generationNumber = 0;
const menuStatePath = ${JSON.stringify(statePath)};
const render = () => {
  const cols = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  if (cols < 18 || rows < 4) return;
  const generation = 'G' + (++generationNumber);
  const labels = Array.from({ length: rows }, (_, index) => 'Synthetic row ' + String(index + 1).padStart(2, '0'));
  labels[0] = generation + ' Agent ready';
  labels[1] = menuActive ? (selected === 1 ? '> 1. First' : '  1. First') : 'Synthetic conversation';
  labels[2] = menuActive ? (selected === 2 ? '> 2. Second' : '  2. Second') : 'Waiting for Stop';
  labels[rows - 1] = menuActive ? (submissions > 0 ? 'Selection submitted' : 'Choose an option') : 'Synthetic Agent busy';
  const lines = labels.map((label) => '│' + label.slice(0, cols - 2).padEnd(cols - 2, ' ') + '│');
  process.stdout.write('\x1b[?7l\x1b[2J');
  for (const [index, line] of lines.entries()) {
    const color = index === 0 ? 32 : menuActive && index === selected ? 36 : index === rows - 1 && submissions > 0 ? 35 : 37;
    process.stdout.write('\x1b[' + (index + 1) + ';1H\x1b[' + color + 'm' + line + '\x1b[0m');
  }
  process.stdout.write('\x1b[?7h');
  fs.writeFileSync(menuStatePath + '.next', JSON.stringify({
    cols,
    firstGridMarker: { columns: cols, generation, rows },
    generation,
    interrupts,
    lines,
    phase: menuActive ? 'menu' : 'busy',
    rows,
    selected,
    submissions,
  }));
  fs.renameSync(menuStatePath + '.next', menuStatePath);
};
const activateMenu = () => {
  if (menuActive) return;
  menuActive = true;
  render();
};
process.stdin.on('data', (chunk) => {
  if (!menuActive) return;
  pending = Buffer.concat([pending, chunk]);
  while (pending.length > 0) {
    const first = pending[0];
    if (first === 27) {
      if (pending.length < 3) break;
      if (pending[1] === 91 && pending[2] === 66) {
        selected = 2;
        process.stdout.write('\x1b[36mSecond selected\x1b[0m\r\n');
      } else if (pending[1] === 91 && pending[2] === 65) {
        selected = 1;
        process.stdout.write('\x1b[36mFirst selected\x1b[0m\r\n');
      }
      pending = pending.subarray(3);
      render();
      continue;
    }
    pending = pending.subarray(1);
    if (first !== 13 && first !== 10) continue;
    submissions += 1;
    render();
  }
});
process.stdout.on('resize', render);
process.on('SIGWINCH', render);
setTimeout(render, 250);
`;
}

async function fakeConversationAgent(
    userDataDirectory: string,
    conversationMenuStatePath?: string,
    codexMenuStatePath?: string,
    inputCapturePath?: string,
) {
    return createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
// 为隔离验收绑定合成 Claude 会话；仅修改当前临时配置中的会话状态。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
// Mobile rename forwards to Desktop's rename, which renames the provider Session through non-interactive /rename.
const resumeIndex = process.argv.indexOf('--resume');
const renameCommand = process.argv.at(-1) ?? '';
if (resumeIndex >= 0 && renameCommand.startsWith('/rename ')) {
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: 'Session renamed to: ' + renameCommand.slice('/rename '.length),
    session_id: process.argv[resumeIndex + 1],
    subtype: 'success',
    type: 'result',
  }));
  process.exit(0);
}
const now = Date.now();
const sessionId = 'mobile-conversation-fixture-' + randomUUID();
const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
const sessionStatePath = path.join(sessions, sessionId + '.json');
const transcriptDirectory = path.join(
  process.env.CLAUDE_CONFIG_DIR,
  'projects',
  process.cwd().replace(/[^a-z0-9]/gi, '-'),
);
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(transcriptDirectory, { recursive: true });
fs.writeFileSync(path.join(transcriptDirectory, sessionId + '.jsonl'), '', { flag: 'wx' });
const writeSessionState = (status) => {
  fs.writeFileSync(sessionStatePath + '.next', JSON.stringify({
    cwd: process.cwd(),
    name: 'Synthetic Conversation',
    sessionId,
    startedAt: now,
    status,
    updatedAt: Date.now(),
  }));
  fs.renameSync(sessionStatePath + '.next', sessionStatePath);
};
writeSessionState('busy');
process.stdin.setRawMode?.(true);
${
    inputCapturePath
        ? `process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(inputCapturePath)}, chunk));`
        : ''
}
${
    conversationMenuStatePath
        ? `${syntheticMenuControllerSource(conversationMenuStatePath)}
process.on('SIGINT', () => {
  interrupts += 1;
  writeSessionState('idle');
  activateMenu();
});`
        : `
process.stdin.on('data', (chunk) => {
  if (chunk.includes(3)) process.exit(130);
});`
}
process.stdin.resume();
process.stdout.write('Synthetic Conversation ready\r\n');
${conversationMenuStatePath ? 'render();' : ''}
`,
            },
            ...(codexMenuStatePath && {
                codex: {
                    executableSource: String.raw`#!${process.execPath}
// 为隔离验收输出合成菜单；只修改临时选择状态文件。
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
if (process.argv.includes('app-server')) process.exit(0);
process.stdin.setRawMode?.(true);
${syntheticMenuControllerSource(codexMenuStatePath)}
process.stdin.resume();
activateMenu();
`,
                },
            }),
        },
    });
}

async function createSyntheticShell(testDirectory: string): Promise<string> {
    const executable = join(testDirectory, 'synthetic-shell');
    await writeFile(
        executable,
        String.raw`#!${process.execPath}
// 为隔离验收绘制合成终端网格；仅修改临时 Project 中的状态回执。
const fs = require('node:fs');
const path = require('node:path');
const statePath = path.join(process.cwd(), '.caxri-synthetic-shell-state.json');
let generationNumber = 0;
const render = () => {
  const columns = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  if (columns < 18 || rows < 4) return;
  const generation = 'synthetic-shell-' + (++generationNumber);
  const firstGridMarker = { columns, generation, rows };
  const lines = Array.from({ length: rows }, (_, index) => {
    const label = 'Synthetic row ' + String(index + 1).padStart(2, '0');
    return '│' + label.padEnd(columns - 2, ' ') + '│';
  });
  process.stdout.write('\x1b[2J');
  for (const [index, line] of lines.entries()) {
    process.stdout.write('\x1b[' + (index + 1) + ';1H' + line);
  }
  fs.writeFileSync(statePath + '.next', JSON.stringify({ columns, firstGridMarker, generation, rows }));
  fs.renameSync(statePath + '.next', statePath);
};
process.stdout.on('resize', render);
process.stdin.resume();
setTimeout(render, 250);
`,
    );
    await chmod(executable, 0o700);
    return executable;
}

export async function createMobileAcceptanceFixture(
    input: CreateMobileAcceptanceFixtureInput,
): Promise<MobileAcceptanceFixture> {
    if (input.mode === 'journey' && input.changes)
        throw new Error('Journey Changes must be seeded after the synthetic Agent action');
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-acceptance-'));
    const userData = join(testDirectory, 'user-data');
    const allowedRoot = join(testDirectory, 'allowed-project');
    const deniedRoot = join(testDirectory, 'denied-project');
    const inputCapture = join(testDirectory, 'agent-input.bin');
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
    if (input.changes) {
        try {
            await seedMobileChangesFixture(allowedRoot, input.changes);
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
    const syntheticShell =
        input.mode === 'shell-conversation' ? await createSyntheticShell(testDirectory) : undefined;
    const agentMode =
        input.mode === 'waiting'
            ? await fakeWaitingAgent(userData, inputCapture)
            : input.mode === 'launch-failure'
              ? await fakeFailingAgent(userData)
              : (conversationAgentMode ?? ({ mode: 'blocked' } as const));
    let running: RunningCaxri;
    try {
        running = await launchCaxri({
            agentMode,
            desktopLeaseWaitMs: process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID ? 120_000 : 0,
            userDataDir: userData,
            testRootPath: allowedRoot,
            env: {
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
    let transcriptPath: string | undefined;
    try {
        /**
         * Destructive Desktop requests still exercise their real Main-process routing, but their native confirmation
         * cannot be answered by Playwright. This fixture owns only disposable Projects, Sessions, and mobile devices.
         */
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ checkboxChecked: false, response: 0 });
        });
        if (input.mode === 'conversation' || input.mode === 'journey') {
            allowedSessionId = await createProjectSession(running.page, 'claude');
            const bound = await waitForMobile(
                () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
                (state) =>
                    state.terminals.some(
                        (terminal) =>
                            terminal.sessionId === allowedSessionId &&
                            terminal.agentSessionId?.startsWith('mobile-conversation-fixture-'),
                    ),
            );
            const allowed = bound.sessions.find(({ id }) => id === allowedSessionId);
            const terminal = bound.terminals.find(
                ({ sessionId }) => sessionId === allowedSessionId,
            );
            const config = conversationAgentMode?.environment.CLAUDE_CONFIG_DIR;
            if (!allowed || !config || !terminal?.agentSessionId)
                throw new Error('Synthetic Conversation binding is unavailable');
            conversationTerminalId = terminal.id;
            transcriptPath = join(
                config,
                'projects',
                terminal.cwd.replaceAll(/[^a-z0-9]/giu, '-'),
                `${terminal.agentSessionId}.jsonl`,
            );
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
                                session.lastActivityState === 'waiting' &&
                                session.attentionEpoch > 0,
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
