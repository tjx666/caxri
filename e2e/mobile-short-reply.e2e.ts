import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { writeJsonAtomic } from '../scripts/atomic-json.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import {
    adbShell,
    mobileSemantics,
    openMobilePairingLink,
    runMobileDeviceCommand,
    tapMobileCheck,
    waitForMobile,
} from './support/mobile-android.ts';

/**
 * The reply text and Terminal preview must never enter Playwright's automatic failure artifacts. The guarded adapter
 * owns the report-bound framebuffer evidence and its privacy scan.
 */
test.use({ screenshot: 'off', trace: 'off' });

const acceptanceToken = 'mobileok';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring.
test('Android sends one bounded reply to a waiting fake Agent', async ({}, testInfo) => {
    const serial = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
    test.skip(!serial, 'Set CAXRI_MOBILE_ACCEPTANCE_SERIAL to an explicit adb device serial');
    if (!serial) return;
    if (process.env.CAXRI_MOBILE_ACCEPTANCE_BUILD_MODE !== 'release')
        throw new Error(
            'Run the guarded Android acceptance script so it installs the current release build',
        );
    const packageState = await adbShell(serial, ['dumpsys', 'package', 'com.caxri.mobile']);
    if (/\bDEBUGGABLE\b/u.test(packageState) || !packageState.includes('versionName=0.0.24'))
        throw new Error('The installed Caxri package is not the expected release build');

    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-acceptance-'));
    const userData = join(testDirectory, 'user-data');
    const allowedRoot = join(testDirectory, 'allowed-project');
    const deniedRoot = join(testDirectory, 'denied-project');
    const inputCapture = join(testDirectory, 'agent-input.bin');
    await Promise.all([
        mkdir(allowedRoot, { recursive: true }),
        mkdir(deniedRoot, { recursive: true }),
    ]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
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
setTimeout(() => {
  invokeHook('UserPromptSubmit', { session_id: fixtureSessionId, turn_id: 'turn-1' });
  invokeHook('PermissionRequest', { session_id: fixtureSessionId, turn_id: 'turn-1' });
}, 500);
`,
            },
        },
    });

    let running: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    let failure: unknown;
    try {
        running = await launchCaxri({
            agentMode,
            userDataDir: userData,
            testRootPath: allowedRoot,
            env: {
                CAXRI_E2E_AGENT_HOOKS: '1',
                CAXRI_TEST_ROOT_PATHS: JSON.stringify([allowedRoot, deniedRoot]),
            },
        });
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        const settings = structuredClone(currentSettings.value);
        settings['agents.providers'].codex.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        const allowedSessionId = await createProjectSession(running.page, 'codex');
        const deniedSessionId = await createProjectSession(running.page, 'codex');
        const waiting = await waitForMobile(
            () => pageRequest<BootstrapState>(running!.page, 'app.bootstrap'),
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
        const allowedSession = waiting.sessions.find(
            (candidate) => candidate.id === allowedSessionId,
        );
        if (!allowedSession)
            throw new Error('The allowed mobile acceptance Session is unavailable');

        await pageRequest(running.page, 'mobile.access.enable');
        const pairing = await pageRequest<{ pairingLink: string }>(
            running.page,
            'mobile.pairing.create',
            { projectIds: [allowedSession.projectId] },
        );

        await adbShell(serial, ['logcat', '-c']);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await openMobilePairingLink(serial, pairing.pairingLink);

        const pairingNodes = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    (node) =>
                        node.checkId === `session-row-${allowedSessionId}` ||
                        node.checkId === 'pairing-error',
                ),
        );
        if (pairingNodes.some((node) => node.checkId === 'pairing-error')) {
            const status = await pageRequest<{ pendingPairingCount: number }>(
                running.page,
                'mobile.access.status',
            );
            const registry = await pageRequest<{ devices: unknown[] }>(
                running.page,
                'mobile.device.list',
            );
            throw new Error(
                `Mobile pairing failed (pending=${status.pendingPairingCount}, paired=${registry.devices.length})`,
            );
        }
        const devices = await pageRequest<{ devices: Array<{ deviceId: string }> }>(
            running.page,
            'mobile.device.list',
        );
        if (pairingNodes.some((node) => node.checkId === `session-row-${deniedSessionId}`))
            throw new Error('The paired device exposed a Session outside its Project grant');
        if (devices.devices.length !== 1) throw new Error('Unexpected paired-device count');
        await tapMobileCheck(serial, `session-row-${allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.some((node) => node.checkId === 'short-reply-input' && node.enabled),
        );
        await tapMobileCheck(serial, 'short-reply-input');
        await adbShell(serial, ['input', 'text', acceptanceToken]);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.some((node) => node.checkId === 'short-reply-send' && node.enabled),
        );
        await tapMobileCheck(serial, 'short-reply-send');

        const captured = await waitForMobile(
            async () => {
                try {
                    return await readFile(inputCapture);
                } catch {
                    return Buffer.alloc(0);
                }
            },
            (value) => value.includes(Buffer.from(`${acceptanceToken}\r`)),
        );
        if (!captured.equals(Buffer.from(`${acceptanceToken}\r`)))
            throw new Error('The fake Agent received unexpected input');
        await waitForMobile(
            () => pageRequest<BootstrapState>(running!.page, 'app.bootstrap'),
            (state) =>
                state.sessions.some(
                    (candidate) =>
                        candidate.id === allowedSessionId &&
                        candidate.lastActivityState === 'running',
                ),
        );
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.some((node) => node.checkId === 'short-reply-send' && !node.enabled),
        );
        await testInfo.attach('android-mobile-receipt.json', {
            body: Buffer.from(
                JSON.stringify(
                    {
                        device: serial,
                        build: 'current-release',
                        pairing: 'encrypted',
                        reply: 'accepted-once',
                        stateAfterReply: 'running',
                        status: 'passed',
                    },
                    null,
                    2,
                ),
            ),
            contentType: 'application/json',
        });
        const resultReceipt = process.env.CAXRI_MOBILE_ACCEPTANCE_RESULT_RECEIPT;
        if (resultReceipt) {
            const launchId = process.env.CAXRI_MOBILE_ACCEPTANCE_LAUNCH_ID;
            const sourceCommit = process.env.CAXRI_MOBILE_ACCEPTANCE_SOURCE_COMMIT;
            if (!launchId || !sourceCommit)
                throw new Error('Report-bound mobile Acceptance identity is incomplete');
            await writeJsonAtomic(resultReceipt, {
                channel: 'authenticated-encrypted-gateway',
                delivery: {
                    count: 1,
                    destination: 'main-agent-terminal',
                    repeatDisabled: true,
                    stateAfterReply: 'running',
                },
                launchId,
                projectScope: 'allowed-present-denied-absent',
                schemaVersion: 1,
                sourceCommit,
                status: 'passed',
            });
        }
    } catch (error) {
        failure = error;
    } finally {
        let cleanupFailure: unknown;
        try {
            if (running) await pageRequest(running.page, 'mobile.access.disable');
        } catch {
            // Deleting the isolated profile removes the remaining paired-device state.
        }
        try {
            await running?.app.close();
        } catch (error) {
            cleanupFailure = error;
        }
        try {
            await adbShell(serial, ['logcat', '-c']);
        } catch (error) {
            cleanupFailure ??= error;
        }
        try {
            await waitForMobile(
                () => runMobileDeviceCommand('/bin/ps', ['-axo', 'pid=,args='], 'capture'),
                (processes) => processes.split('\n').every((line) => !line.includes(userData)),
            );
        } catch {
            cleanupFailure ??= new Error('The isolated mobile acceptance process did not stop');
        }
        try {
            await rm(testDirectory, { recursive: true, force: true });
        } catch (error) {
            cleanupFailure ??= error;
        }
        failure ??= cleanupFailure;
    }
    if (failure)
        throw failure instanceof Error
            ? failure
            : new Error('Mobile acceptance failed with a non-Error value');
});
