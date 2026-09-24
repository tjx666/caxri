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
    tapMobileCheck,
    waitForMobile,
} from './support/mobile-android.ts';
import { createMobileTerminalAcceptanceFixture } from './support/mobile-terminal-acceptance-fixture.ts';

/**
 * Mobile failure screenshots and traces can contain synthetic reply or Terminal-preview content outside the frozen
 * report. Scenario-owned framebuffer evidence is the only capture path and is covered by the privacy finalizer.
 */
test.use({ screenshot: 'off', trace: 'off' });

const serial = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
const caseId = process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID;
const assetsDirectory = process.env.CAXRI_MOBILE_ACCEPTANCE_ASSETS_DIR;
const artifactManifestPath = process.env.CAXRI_MOBILE_ACCEPTANCE_ARTIFACT_MANIFEST;
const scenarioReceiptPath = process.env.CAXRI_MOBILE_ACCEPTANCE_SCENARIO_RECEIPT;

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

function androidBounds(source: string): {
    left: number;
    top: number;
    right: number;
    bottom: number;
} {
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(source);
    if (!match) throw new Error('Android Terminal key bar bounds are unavailable');
    const [, left, top, right, bottom] = match.map(Number);
    if (right <= left || bottom <= top)
        throw new Error('Android Terminal key bar bounds are invalid');
    return { left, top, right, bottom };
}

async function tapTerminalKey(serial: string, key: 'down' | 'enter'): Promise<void> {
    const checkId = `terminal-key-${key}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- every swipe needs a fresh sanitized device view.
        const nodes = await mobileSemantics(serial);
        const bar = nodes.find((node) => node.checkId === 'terminal-key-bar');
        if (!bar) throw new Error('Android Terminal key bar is unavailable');
        const barBounds = androidBounds(bar.bounds);
        const target = nodes.find((node) => node.checkId === checkId);
        if (target?.clickable && target.enabled) {
            const targetBounds = androidBounds(target.bounds);
            const centerX = (targetBounds.left + targetBounds.right) / 2;
            if (centerX > barBounds.left && centerX < barBounds.right) {
                // eslint-disable-next-line no-await-in-loop -- this is the only reachable key after inspection.
                await tapMobileCheck(serial, checkId);
                return;
            }
        }
        const y = Math.floor((barBounds.top + barBounds.bottom) / 2);
        // eslint-disable-next-line no-await-in-loop -- the next semantic inspection must observe this gesture.
        await adbShell(serial, [
            'input',
            'swipe',
            String(barBounds.right - 20),
            String(y),
            String(barBounds.left + 20),
            String(y),
            '300',
        ]);
    }
    throw new Error(`Android Terminal ${key} key could not be reached`);
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
                            ({ checkId, enabled }) => checkId === 'short-reply-send' && !enabled,
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
        default:
            throw new Error(`Unsupported Playwright mobile Acceptance case: ${environment.caseId}`);
    }
});
