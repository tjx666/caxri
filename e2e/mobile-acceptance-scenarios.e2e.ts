import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from '../scripts/atomic-json.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest } from './support/helpers.ts';
import { createMobileAcceptanceFixture } from './support/mobile-acceptance-fixture.ts';
import {
    adbShell,
    captureMobileFramebuffer,
    mobileDisplayState,
    mobileSemantics,
    restoreMobileDisplayState,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './support/mobile-android.ts';
import { executeMobileChangesScenario } from './support/mobile-changes-scenarios.ts';
import { executeMobileConversationScenario } from './support/mobile-conversation-scenarios.ts';
import {
    countByteSequence,
    executeMobileEndToEndScenario,
} from './support/mobile-end-to-end-scenarios.ts';
import { executeMobileNewSessionScenario } from './support/mobile-new-session-scenarios.ts';
import { executeMobileProjectPanelsScenario } from './support/mobile-project-panels-scenarios.ts';
import { executeMobileRecoveryScenario } from './support/mobile-recovery-scenarios.ts';
import { executeMobileSessionRefreshScenario } from './support/mobile-session-refresh-scenarios.ts';
import { executeMobileTerminalScenario } from './support/mobile-terminal-scenarios.ts';
import { executeMobileUiAuditScenario } from './support/mobile-ui-audit-scenarios.ts';
import {
    assertMobileComposerDraft,
    assertMobileUnknownFeedback,
    setMobileComposerUnicode,
} from './support/mobile-unicode-input.ts';

/**
 * Scenario-owned framebuffer evidence is the only capture path covered by the privacy finalizer.
 */
test.use({ screenshot: 'off', trace: 'off' });

const serial = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
const caseId = process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID;
const assetsDirectory = process.env.CAXRI_MOBILE_ACCEPTANCE_ASSETS_DIR;
const artifactManifestPath = process.env.CAXRI_MOBILE_ACCEPTANCE_ARTIFACT_MANIFEST;
const scenarioReceiptPath = process.env.CAXRI_MOBILE_ACCEPTANCE_SCENARIO_RECEIPT;
const remoteVideoPath = process.env.CAXRI_MOBILE_ACCEPTANCE_REMOTE_VIDEO_PATH;
const sourceCommit = process.env.CAXRI_MOBILE_ACCEPTANCE_SOURCE_COMMIT;
const launchId = process.env.CAXRI_MOBILE_ACCEPTANCE_LAUNCH_ID;

function requireEnvironment(): {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
} {
    if (!serial || !caseId || !assetsDirectory || !artifactManifestPath || !scenarioReceiptPath) {
        throw new Error('Mobile Acceptance scenario identity is incomplete');
    }
    return { artifactManifestPath, assetsDirectory, caseId, scenarioReceiptPath, serial };
}

async function capture(
    environment: ReturnType<typeof requireEnvironment>,
    label: string,
    artifacts: string[],
): Promise<void> {
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
    environment: ReturnType<typeof requireEnvironment>,
    artifacts: string[],
    receipt: Record<string, unknown>,
): Promise<void> {
    await Promise.all([
        writeJsonAtomic(environment.artifactManifestPath, { artifacts, schemaVersion: 1 }),
        writeFile(
            environment.scenarioReceiptPath,
            `${JSON.stringify({ ...receipt, caseId: environment.caseId, schemaVersion: 1 }, null, 2)}\n`,
            'utf8',
        ),
    ]);
}

async function openComposerSession(serial: string, sessionId: string): Promise<void> {
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'session-detail') &&
            nodes.some(({ checkId }) => checkId === 'session-composer-input'),
    );
    await tapMobileCheck(serial, 'session-segment-conversation');
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'conversation-fallback-banner') &&
            nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
    );
}

function requireRemoteVideoPath(): string {
    if (!remoteVideoPath) throw new Error('Scenario-owned Android recording path is unavailable');
    return remoteVideoPath;
}

async function enterComposerText(
    serial: string,
    value: string,
    mode: 'commit' | 'compose' = 'commit',
): Promise<void> {
    await setMobileComposerUnicode(serial, value, mode);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId, enabled }) => checkId === 'session-composer-send' && enabled),
    );
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument.
test('executes one report-bound Android product scenario', async ({}) => {
    test.skip(!caseId, 'Run through the guarded Android Acceptance adapter');
    /**
     * Reserve bounded queue time without shortening the product scenario's deadline.
     */
    test.setTimeout(210_000);
    const environment = requireEnvironment();
    const artifacts: string[] = [];
    if (environment.caseId.startsWith('MOB-E2E-')) {
        test.setTimeout(420_000);
        if (!sourceCommit || !launchId)
            throw new Error('Integrated journey Acceptance identity is incomplete');
        await executeMobileEndToEndScenario(
            { ...environment, launchId, remoteVideoPath, sourceCommit },
            artifacts,
        );
        return;
    }

    switch (environment.caseId) {
        case 'MOB-SESSION-PUSH-01':
            test.setTimeout(300_000);
            await executeMobileSessionRefreshScenario(environment, artifacts);
            break;
        case 'MOB-PAIR-CANCEL-01':
        case 'MOB-RENDER-01':
        case 'MOB-STORAGE-01':
            await executeMobileRecoveryScenario({ ...environment, remoteVideoPath }, artifacts);
            break;
        case 'MOB-PAIR-02': {
            await adbShell(environment.serial, [
                'am',
                'start',
                '-W',
                'com.caxri.mobile/.MainActivity',
            ]);
            await waitForMobile(
                () => mobileSemantics(environment.serial),
                (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
            );
            await capture(environment, 'first-connect', artifacts);
            await tapMobileCheck(environment.serial, 'pairing-scan-button');
            await waitForMobile(
                () => mobileSemantics(environment.serial),
                (nodes) =>
                    nodes.some(({ checkId }) => checkId === 'pairing-camera-permission-button'),
            );
            const camera = await adbShell(environment.serial, [
                'dumpsys',
                'package',
                'com.caxri.mobile',
            ]);
            if (!/android\.permission\.CAMERA:\s+granted=false/u.test(camera)) {
                throw new Error('Camera permission is not in the expected denied state');
            }
            await capture(environment, 'camera-denied', artifacts);
            await tapMobileCheck(environment.serial, 'pairing-scan-back-button');
            const fixture = await createMobileAcceptanceFixture({
                mode: 'empty',
                serial: environment.serial,
            });
            try {
                await fixture.pair();
                await capture(environment, 'paired-empty-sessions', artifacts);
            } finally {
                await fixture.stop();
            }
            await finish(environment, artifacts, {
                cameraPermission: 'denied',
                fallback: 'paste-entry-remained-available',
                outcome: 'paired-empty-sessions',
                status: 'passed',
            });
            break;
        }
        case 'MOB-PAIR-03': {
            const fixture = await createMobileAcceptanceFixture({
                mode: 'empty',
                serial: environment.serial,
            });
            try {
                const online = await fixture.pair();
                const revokedAt = Date.now();
                await pageRequest(fixture.running.page, 'mobile.device.revoke', {
                    deviceId: online.deviceId,
                });
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
                    5_000,
                );
                const onlineDurationMs = Date.now() - revokedAt;
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
                );

                const offline = await fixture.pair();
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await pageRequest(fixture.running.page, 'mobile.device.revoke', {
                    deviceId: offline.deviceId,
                });
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-list-unverified') &&
                        nodes.some(({ checkId }) => checkId === 'forget-device-button') &&
                        nodes.some(({ checkId }) => checkId === 'connection-retry-button'),
                );
                await finish(environment, artifacts, {
                    offlineAuthentication: 'unverified-credential-preserved',
                    onlineRevocation: 'credential-cleared',
                    onlineRevocationDurationMs: onlineDurationMs,
                    status: 'passed',
                });
            } finally {
                await fixture.stop();
            }
            break;
        }
        case 'MOB-SESSION-01': {
            const originalDisplay = await mobileDisplayState(environment.serial);
            const fixture = await createMobileAcceptanceFixture({
                mode: 'waiting',
                serial: environment.serial,
            });
            try {
                await fixture.pair();
                const allowedSessionId = fixture.allowedSessionId;
                if (!allowedSessionId) throw new Error('Waiting Session is unavailable');
                await capture(environment, 'phone-list', artifacts);
                await tapMobileCheck(environment.serial, `session-row-${allowedSessionId}`);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
                );
                await capture(environment, 'phone-detail', artifacts);

                await adbShell(environment.serial, ['wm', 'size', '1600x2560']);
                await adbShell(environment.serial, ['wm', 'density', '320']);
                /**
                 * The Android emulator reports the 800dp tablet configuration only after Activity recreation; changing
                 * `wm` overrides underneath the running React Native Activity leaves its Window metrics unchanged.
                 */
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === `session-row-${allowedSessionId}`),
                );
                await tapMobileCheck(environment.serial, `session-row-${allowedSessionId}`);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-list') &&
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
                );
                await capture(environment, 'tablet-split', artifacts);
                await restoreMobileDisplayState(environment.serial, originalDisplay);
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'session-list'),
                );

                await pageRequest(fixture.running.page, 'session.delete', {
                    sessionId: allowedSessionId,
                });
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'session-list-empty'),
                );
                await capture(environment, 'empty', artifacts);
                await pageRequest(fixture.running.page, 'mobile.access.disable');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'connection-stale-banner'),
                    7_000,
                );
                await capture(environment, 'stale-error', artifacts);
                await finish(environment, artifacts, {
                    displayAfter: await mobileDisplayState(environment.serial),
                    displayBefore: originalDisplay,
                    states: ['phone-list', 'phone-detail', 'tablet-split', 'empty', 'stale-error'],
                    terminalPreview: 'synthetic-non-empty',
                    status: 'passed',
                });
            } finally {
                await restoreMobileDisplayState(environment.serial, originalDisplay);
                await fixture.stop();
            }
            break;
        }
        case 'MOB-SESSION-03': {
            const fixture = await createMobileAcceptanceFixture({
                mode: 'waiting',
                serial: environment.serial,
            });
            let isNetworkDisabled = false;
            try {
                await fixture.pair();
                if (!fixture.allowedSessionId) throw new Error('Waiting Session is unavailable');
                await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
                const disconnectedAt = Date.now();
                isNetworkDisabled = true;
                await setMobileNetworkAvailable(environment.serial, false);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'connection-stale-banner') &&
                        nodes.some(
                            ({ checkId, enabled }) =>
                                checkId === 'session-composer-send' && !enabled,
                        ),
                    7_000,
                );
                const staleDurationMs = Date.now() - disconnectedAt;
                await setMobileNetworkAvailable(environment.serial, true);
                isNetworkDisabled = false;
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.every(({ checkId }) => checkId !== 'connection-stale-banner') &&
                        nodes.some(({ checkId }) => checkId === 'session-detail'),
                    30_000,
                );
                await finish(environment, artifacts, {
                    contentDuringStale: 'preserved',
                    recovery: 'automatic-without-restart',
                    staleDurationMs,
                    status: 'passed',
                });
            } finally {
                if (isNetworkDisabled) await setMobileNetworkAvailable(environment.serial, true);
                await fixture.stop();
            }
            break;
        }
        case 'MOB-TERM-01':
            test.setTimeout(420_000);
            await executeMobileTerminalScenario(
                { ...environment, launchId, sourceCommit, remoteVideoPath },
                artifacts,
                capture,
                finish,
            );
            break;
        case 'MOB-COMPOSER-01': {
            const fixture = await createMobileAcceptanceFixture({
                mode: 'waiting',
                serial: environment.serial,
            });
            const message = '请检查第一项。\n然后继续第二项。';
            let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
            try {
                await fixture.pair();
                if (!fixture.allowedSessionId) throw new Error('Composer Session is unavailable');
                await openComposerSession(environment.serial, fixture.allowedSessionId);
                recording = await startMobileFramebufferRecording(
                    environment.serial,
                    requireRemoteVideoPath(),
                );
                await enterComposerText(environment.serial, message, 'compose');
                await capture(environment, 'multiline-draft', artifacts);
                const before = await fixture.readCapturedInput();
                expect(before.length).toBe(0);
                await tapMobileCheck(environment.serial, 'session-composer-send');
                const submitted = Buffer.from(`\u{1B}[200~${message}\u{1B}[201~\r`, 'utf8');
                const captured = await waitForMobile(
                    () => fixture.readCapturedInput(),
                    (input) => countByteSequence(input, submitted) === 1,
                );
                expect(countByteSequence(captured, submitted)).toBe(1);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-composer-feedback') &&
                        nodes.some(
                            ({ checkId, enabled }) =>
                                checkId === 'session-composer-stop' ||
                                (checkId === 'session-composer-send' && !enabled),
                        ),
                );
                await capture(environment, 'delivered', artifacts);
                await finish(environment, artifacts, {
                    draftAfter: 'cleared',
                    encodedInput: 'utf8-multiline-once',
                    imeInput: 'setComposingText-finishComposingText',
                    inputBeforeSend: 'none',
                    status: 'passed',
                });
            } finally {
                await recording?.stop();
                await fixture.stop();
            }
            break;
        }
        case 'MOB-COMPOSER-02': {
            const fixture = await createMobileAcceptanceFixture({
                mode: 'waiting',
                serial: environment.serial,
            });
            let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
            try {
                await fixture.pair();
                if (!fixture.allowedSessionId) throw new Error('Composer Session is unavailable');
                await openComposerSession(environment.serial, fixture.allowedSessionId);
                recording = await startMobileFramebufferRecording(
                    environment.serial,
                    requireRemoteVideoPath(),
                );
                await enterComposerText(environment.serial, 'Continue synthetic task');
                await tapMobileCheck(environment.serial, 'session-composer-send');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-stop'),
                );
                await capture(environment, 'running-stop', artifacts);
                await tapMobileCheck(environment.serial, 'session-composer-stop');
                await waitForMobile(
                    () =>
                        pageRequest<{
                            sessions: Array<{ id: string; lastActivityState?: string }>;
                        }>(fixture.running.page, 'app.bootstrap'),
                    (state) =>
                        state.sessions.some(
                            (session) =>
                                session.id === fixture.allowedSessionId &&
                                session.lastActivityState !== 'running',
                        ),
                );
                await capture(environment, 'stopped', artifacts);
                await finish(environment, artifacts, {
                    action: 'target-Agent-interrupted',
                    input: 'empty-at-stop',
                    status: 'passed',
                });
            } finally {
                await recording?.stop();
                await fixture.stop();
            }
            break;
        }
        case 'MOB-COMPOSER-03': {
            const fixture = await createMobileAcceptanceFixture({
                dropSubmitAcknowledgement: true,
                mode: 'waiting',
                serial: environment.serial,
            });
            const message = 'Synthetic uncertain delivery';
            let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
            try {
                await fixture.pair();
                if (!fixture.allowedSessionId) throw new Error('Composer Session is unavailable');
                await openComposerSession(environment.serial, fixture.allowedSessionId);
                recording = await startMobileFramebufferRecording(
                    environment.serial,
                    requireRemoteVideoPath(),
                );
                await enterComposerText(environment.serial, message);
                await tapMobileCheck(environment.serial, 'session-composer-send');
                const submitted = Buffer.from(`\u{1B}[200~${message}\u{1B}[201~\r`, 'utf8');
                const captured = await waitForMobile(
                    () => fixture.readCapturedInput(),
                    (input) => countByteSequence(input, submitted) === 1,
                );
                expect(countByteSequence(captured, submitted)).toBe(1);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'session-composer-feedback'),
                );
                await assertMobileUnknownFeedback(environment.serial);
                await assertMobileComposerDraft(environment.serial, message);
                await capture(environment, 'result-unknown', artifacts);
                await finish(environment, artifacts, {
                    draft: 'retained',
                    hostWrite: 'once-before-ack-drop',
                    status: 'passed',
                });
            } finally {
                await recording?.stop();
                await fixture.stop();
            }
            break;
        }
        case 'MOB-NEW-01':
        case 'MOB-NEW-02':
        case 'MOB-CROSS-01':
        case 'MOB-PARTIAL-01':
            if (!sourceCommit || !launchId)
                throw new Error('New Session Acceptance identity is incomplete');
            await executeMobileNewSessionScenario(
                { ...environment, launchId, remoteVideoPath, sourceCommit },
                artifacts,
            );
            break;
        case 'MOB-PROJECT-01':
        case 'MOB-PANELS-01':
            await executeMobileProjectPanelsScenario(environment, artifacts);
            break;
        case 'MOB-TIMELINE-01':
        case 'MOB-CONV-01':
        case 'MOB-CONV-02':
        case 'MOB-CONV-03':
        case 'MOB-CONV-04':
        case 'MOB-UI-04':
            await executeMobileConversationScenario(
                { ...environment, launchId, sourceCommit },
                artifacts,
            );
            break;
        case 'MOB-UI-01':
        case 'MOB-UI-02':
        case 'MOB-UI-03':
        case 'MOB-UI-05':
        case 'MOB-UI-06':
        case 'MOB-UI-07':
            await executeMobileUiAuditScenario(environment, artifacts);
            break;
        case 'MOB-CHANGES-01':
        case 'MOB-CHANGES-02':
        case 'MOB-CHANGES-03':
        case 'MOB-CHANGES-04':
            await executeMobileChangesScenario(environment, artifacts);
            break;
        default:
            throw new Error(`Unsupported Playwright mobile Acceptance case: ${environment.caseId}`);
    }
});
