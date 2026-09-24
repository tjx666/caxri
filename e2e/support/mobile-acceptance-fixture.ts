import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './agent-fixture';
import type { RunningCaxri } from './helpers';
import { createProjectSession, launchCaxri, pageRequest } from './helpers';
import {
    mobileSemantics,
    openMobilePairingLink,
    runMobileDeviceCommand,
    waitForMobile,
} from './mobile-android';

export interface MobileAcceptanceFixture {
    allowedProjectId: string;
    allowedSessionId?: string;
    deniedProjectId: string;
    deniedSessionId?: string;
    inputCapture?: string;
    pair(): Promise<{ deviceId: string }>;
    pairFromDesktopUi(trigger: () => Promise<void>): Promise<{ deviceId: string }>;
    readCapturedInput(): Promise<Buffer>;
    running: RunningCaxri;
    stop(): Promise<void>;
    testDirectory: string;
}

interface CreateMobileAcceptanceFixtureInput {
    mode: 'empty' | 'waiting';
    serial: string;
}

export const MOBILE_ACCEPTANCE_SAFE_OUTPUT =
    'Synthetic Agent output: ready for Acceptance review.\r\n';

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
  if (!resumed) {
    resumed = true;
    invokeHook('UserPromptSubmit', { session_id: fixtureSessionId, turn_id: 'turn-2' });
  }
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

export async function createMobileAcceptanceFixture(
    input: CreateMobileAcceptanceFixtureInput,
): Promise<MobileAcceptanceFixture> {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-acceptance-'));
    const userData = join(testDirectory, 'user-data');
    const allowedRoot = join(testDirectory, 'allowed-project');
    const deniedRoot = join(testDirectory, 'denied-project');
    const inputCapture = join(testDirectory, 'agent-input.bin');
    await Promise.all([
        mkdir(allowedRoot, { recursive: true }),
        mkdir(deniedRoot, { recursive: true }),
    ]);
    const agentMode =
        input.mode === 'waiting'
            ? await fakeWaitingAgent(userData, inputCapture)
            : ({ mode: 'blocked' } as const);
    let running: RunningCaxri;
    try {
        running = await launchCaxri({
            agentMode,
            userDataDir: userData,
            testRootPath: allowedRoot,
            env: {
                ...(input.mode === 'waiting' && { CAXRI_E2E_AGENT_HOOKS: '1' }),
                CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host',
                CAXRI_TEST_ROOT_PATHS: JSON.stringify([allowedRoot, deniedRoot]),
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
    try {
        /**
         * Destructive Desktop requests still exercise their real Main-process routing, but their native confirmation
         * cannot be answered by Playwright. This fixture owns only disposable Projects, Sessions, and mobile devices.
         */
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ checkboxChecked: false, response: 0 });
        });
        if (input.mode === 'waiting') {
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
            await pageRequest(running.page, 'session.delete', {
                sessionId: allowedEmptySessionId,
            });
            await pageRequest(running.page, 'session.delete', {
                sessionId: deniedEmptySessionId,
            });
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
    return {
        allowedProjectId,
        allowedSessionId,
        deniedProjectId,
        deniedSessionId,
        ...(input.mode === 'waiting' && { inputCapture }),
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
            if (input.mode !== 'waiting') return Buffer.alloc(0);
            try {
                return await readFile(inputCapture);
            } catch {
                return Buffer.alloc(0);
            }
        },
        running,
        stop,
        testDirectory,
    };
}
