import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from '../scripts/atomic-json.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { pageRequest } from './support/helpers.ts';
import { createMobileAcceptanceFixture } from './support/mobile-acceptance-fixture.ts';
import {
    adbShell,
    androidBounds,
    captureMobileFramebuffer,
    mobileDisplayState,
    mobileSemantics,
    restoreMobileDisplayState,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './support/mobile-android.ts';
import { executeMobileConversationScenario } from './support/mobile-conversation-scenarios.ts';
import { createMobileTerminalAcceptanceFixture } from './support/mobile-terminal-acceptance-fixture.ts';
import {
    assertMobileComposerDraft,
    assertMobileComposerFocused,
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

async function tapTerminalKey(serial: string, key: 'down' | 'enter'): Promise<void> {
    const checkId = `terminal-key-${key}`;
    const display = await mobileDisplayState(serial);
    const frame = display.size.override ?? display.size.physical;
    const isOnFrame = (bounds: NonNullable<ReturnType<typeof androidBounds>>): boolean =>
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= frame.width &&
        bounds.bottom <= frame.height;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- every swipe needs a fresh sanitized device view.
        const nodes = await mobileSemantics(serial);
        if (nodes.every(({ checkId }) => checkId !== 'session-detail'))
            throw new Error('Android left Session detail while locating a Terminal key');
        const target = nodes.find((node) => node.checkId === checkId);
        if (target?.clickable && target.enabled) {
            const targetBounds = androidBounds(target.bounds);
            if (targetBounds && isOnFrame(targetBounds)) {
                // eslint-disable-next-line no-await-in-loop -- this is the only reachable key after inspection.
                await tapMobileCheck(serial, checkId);
                return;
            }
        }
        const visibleKeys = nodes
            .filter(({ checkId: id }) =>
                /^terminal-key-(?:escape|tab|ctrl|up|down|left|right|[123]|enter|paste)$/u.test(id),
            )
            .map((node) => androidBounds(node.bounds))
            .filter((bounds): bounds is NonNullable<typeof bounds> =>
                Boolean(bounds && isOnFrame(bounds)),
            )
            .toSorted((left, right) => left.left - right.left);
        const first = visibleKeys.at(0);
        if (!first)
            throw new Error(
                `Android Terminal has no visible key to locate its row: ${JSON.stringify(
                    {
                        frame,
                        keys: nodes
                            .filter(({ checkId: id }) => id.startsWith('terminal-key-'))
                            .map(({ bounds, checkId, clickable, enabled }) => ({
                                bounds,
                                checkId,
                                clickable,
                                enabled,
                            })),
                    },
                    null,
                    2,
                )}`,
            );
        const last = visibleKeys.at(-1) ?? first;
        const y = Math.floor((first.top + first.bottom) / 2);
        /**
         * Android Back swipes begin at either edge, so keep the key-row gesture inside the screen.
         *
         * @see https://developer.android.com/develop/ui/views/touch-and-input/gestures/gesturenav
         */
        const edgeInset = Math.floor(frame.width / 5);
        const startX = Math.min(
            frame.width - edgeInset,
            Math.max(last.right - 8, first.right + 80),
        );
        const endX = Math.max(edgeInset, first.left + 8);
        if (startX <= endX) throw new Error('Android Terminal key row cannot be scrolled');
        // eslint-disable-next-line no-await-in-loop -- the next semantic inspection must observe this gesture.
        await adbShell(serial, [
            'input',
            'swipe',
            String(startX),
            String(y),
            String(endX),
            String(y),
            '300',
        ]);
    }
    throw new Error(`Android Terminal ${key} key could not be reached`);
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

async function enterComposerText(serial: string, value: string): Promise<void> {
    await setMobileComposerUnicode(serial, value);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId, enabled }) => checkId === 'session-composer-send' && enabled),
    );
}

function countByteSequence(source: Buffer, target: Buffer): number {
    let count = 0;
    for (
        let offset = source.indexOf(target);
        offset !== -1;
        offset = source.indexOf(target, offset + target.length)
    ) {
        count += 1;
    }
    return count;
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument.
test('executes one report-bound Android product scenario', async ({}) => {
    test.skip(!caseId, 'Run through the guarded Android Acceptance adapter');
    const environment = requireEnvironment();
    const artifacts: string[] = [];

    switch (environment.caseId) {
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
                        nodes.some(({ checkId }) => checkId === 'terminal-preview-populated'),
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
                        nodes.some(({ checkId }) => checkId === 'terminal-preview-populated'),
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
        case 'MOB-TERM-01': {
            const fixture = await createMobileTerminalAcceptanceFixture(environment.serial);
            try {
                const surface = fixture.running.page.locator(
                    `.terminal-pane[data-terminal-id="${fixture.terminalId}"] .terminal-surface`,
                );
                await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
                await expect(surface).toHaveAttribute('data-terminal-grid', /^\d+x\d+$/u);
                const desktopGrid = await surface.getAttribute('data-terminal-grid');
                const grid = /^(\d+)x(\d+)$/u.exec(desktopGrid ?? '');
                if (!grid) throw new Error('Desktop Terminal grid is unavailable');
                const desktopSize = { cols: Number(grid[1]), rows: Number(grid[2]) };
                await waitForMobile(
                    () => fixture.menuState(),
                    ({ cols, rows }) => cols === desktopSize.cols && rows === desktopSize.rows,
                );

                await fixture.pair();
                await tapMobileCheck(environment.serial, `session-row-${fixture.sessionId}`);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
                );
                await tapMobileCheck(environment.serial, 'session-segment-terminal');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'terminal-live-webview') &&
                        nodes.some(
                            ({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled,
                        ),
                );
                await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
                const observingSize = await fixture.menuState();
                expect({ cols: observingSize.cols, rows: observingSize.rows }).toEqual(desktopSize);
                await capture(environment, 'observing', artifacts);

                await tapMobileCheck(environment.serial, 'terminal-take-over');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-release'),
                );
                const takenOver = await waitForMobile(
                    () => fixture.menuState(),
                    ({ cols }) => cols !== null && cols < desktopSize.cols,
                );
                await capture(environment, 'taken-over', artifacts);

                await tapTerminalKey(environment.serial, 'down');
                await waitForMobile(
                    () => fixture.menuState(),
                    ({ selected }) => selected === 2,
                );
                await tapTerminalKey(environment.serial, 'enter');
                await waitForMobile(
                    () => fixture.menuState(),
                    ({ submissions }) => submissions === 1,
                );
                await waitForMobile(
                    () =>
                        surface
                            .locator('.xterm-rows')
                            .evaluate((rows) => rows.textContent.includes('Selection submitted')),
                    Boolean,
                );
                await capture(environment, 'menu-submitted', artifacts);

                await tapMobileCheck(environment.serial, 'terminal-release');
                const released = await waitForMobile(
                    () => fixture.menuState(),
                    ({ cols, rows }) => cols === desktopSize.cols && rows === desktopSize.rows,
                );
                await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
                await capture(environment, 'released', artifacts);
                await finish(environment, artifacts, {
                    desktopAttachment: 'preserved',
                    desktopSize,
                    menuSelection: 'second-option-submitted-once',
                    observingSize: { cols: observingSize.cols, rows: observingSize.rows },
                    releasedSize: { cols: released.cols, rows: released.rows },
                    status: 'passed',
                    takenOverSize: { cols: takenOver.cols, rows: takenOver.rows },
                });
            } finally {
                await fixture.stop();
            }
            break;
        }
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
                await enterComposerText(environment.serial, message);
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
        case 'MOB-NEW-01': {
            const fixture = await createMobileAcceptanceFixture({
                mode: 'waiting',
                serial: environment.serial,
            });
            try {
                await fixture.pair();
                const before = await pageRequest<{
                    selectedSessionId?: string;
                    sessions: Array<{ id: string }>;
                }>(fixture.running.page, 'app.bootstrap');
                if (!before.selectedSessionId)
                    throw new Error('Desktop Session selection is unavailable');
                await tapMobileCheck(environment.serial, 'new-session-button');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'new-session-screen') &&
                        nodes.some(
                            ({ checkId }) =>
                                checkId === `new-session-project-${fixture.allowedProjectId}`,
                        ) &&
                        nodes.some(
                            ({ checkId, enabled }) =>
                                checkId === 'new-session-agent-codex' && enabled,
                        ),
                );
                await tapMobileCheck(
                    environment.serial,
                    `new-session-project-${fixture.allowedProjectId}`,
                );
                await tapMobileCheck(environment.serial, 'new-session-agent-codex');
                await capture(environment, 'selection', artifacts);
                await tapMobileCheck(environment.serial, 'new-session-create');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'session-detail') &&
                        nodes.some(({ checkId }) => checkId === 'session-composer-input'),
                );
                await assertMobileComposerFocused(environment.serial);
                await tapMobileCheck(environment.serial, 'session-segment-conversation');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'conversation-fallback-banner') &&
                        nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
                );
                const after = await pageRequest<{
                    selectedSessionId?: string;
                    sessions: Array<{ id: string }>;
                }>(fixture.running.page, 'app.bootstrap');
                expect(after.selectedSessionId).toBe(before.selectedSessionId);
                expect(after.sessions.length).toBe(before.sessions.length + 1);
                await capture(environment, 'created', artifacts);
                await finish(environment, artifacts, {
                    agent: 'synthetic-Codex',
                    composer: 'focused',
                    desktopSelection: 'preserved',
                    status: 'passed',
                });
            } finally {
                await fixture.stop();
            }
            break;
        }
        case 'MOB-NEW-02': {
            allowE2EErrors([
                { source: 'server-core', event: 'pty.spawn_failed', code: 'UNAVAILABLE', count: 1 },
            ]);
            const fixture = await createMobileAcceptanceFixture({
                mode: 'launch-failure',
                serial: environment.serial,
            });
            try {
                await fixture.pair();
                await tapMobileCheck(environment.serial, 'new-session-button');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(
                            ({ checkId }) =>
                                checkId === `new-session-project-${fixture.allowedProjectId}`,
                        ) &&
                        nodes.some(
                            ({ checkId, enabled }) =>
                                checkId === 'new-session-agent-codex' && enabled,
                        ),
                );
                await tapMobileCheck(
                    environment.serial,
                    `new-session-project-${fixture.allowedProjectId}`,
                );
                await tapMobileCheck(environment.serial, 'new-session-agent-codex');
                await fixture.failNextAgentLaunch();
                await tapMobileCheck(environment.serial, 'new-session-create');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) =>
                        nodes.some(({ checkId }) => checkId === 'new-session-screen') &&
                        nodes.some(({ checkId }) => checkId === 'new-session-create-error') &&
                        nodes.some(
                            ({ checkId }) =>
                                checkId === `new-session-project-${fixture.allowedProjectId}`,
                        ) &&
                        nodes.some(({ checkId }) => checkId === 'new-session-agent-codex'),
                );
                await capture(environment, 'launch-failure-selection-retained', artifacts);
                await finish(environment, artifacts, {
                    agent: 'synthetic-Codex-launch-failure',
                    result: 'error-shown-selection-retained',
                    status: 'passed',
                });
            } finally {
                await fixture.stop();
            }
            break;
        }
        case 'MOB-TIMELINE-01':
        case 'MOB-CONV-01':
        case 'MOB-CONV-02':
        case 'MOB-CONV-03':
        case 'MOB-CONV-04':
            await executeMobileConversationScenario(environment, artifacts);
            break;
        default:
            throw new Error(`Unsupported Playwright mobile Acceptance case: ${environment.caseId}`);
    }
});
