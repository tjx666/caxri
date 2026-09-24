import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { test } from './support/fixtures.ts';
import {
    adbShell,
    captureMobileFramebuffer,
    mobileDisplayState,
    mobileSemantics,
    pullMobileFramebufferRecording,
    restoreMobileDisplayState,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './support/mobile-android.ts';
import { createMobileDashboardParityFixture } from './support/mobile-dashboard-parity-fixture.ts';

/**
 * This local parity round captures only synthetic Session metadata. Failure attachments are disabled because a default
 * Playwright screenshot could include the Agent's Terminal preview or a device pairing link.
 */
test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test.setTimeout(180_000);

const serial = process.env.CAXRI_MOBILE_PARITY_SERIAL;
const assetsDirectory = process.env.CAXRI_MOBILE_PARITY_ASSETS_DIR;
const receiptPath = process.env.CAXRI_MOBILE_PARITY_RECEIPT;

function requireEnvironment(): { assetsDirectory: string; receiptPath: string; serial: string } {
    if (!serial || !assetsDirectory || !receiptPath)
        throw new Error('Mobile dashboard parity environment is incomplete');
    return { assetsDirectory, receiptPath, serial };
}

async function launchMobile(serial: string): Promise<void> {
    await adbShell(serial, ['am', 'force-stop', 'com.caxri.mobile']);
    await adbShell(serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
}

async function waitForRows(serial: string, sessionIds: string[]): Promise<void> {
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'session-list') &&
            sessionIds.every((id) => nodes.some(({ checkId }) => checkId === `session-row-${id}`)),
    );
}

async function showConversation(serial: string): Promise<void> {
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
    );
    await tapMobileCheck(serial, 'session-segment-conversation');
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId }) => checkId === 'conversation-placeholder') &&
            nodes.every(({ checkId }) => checkId !== 'terminal-preview-populated'),
    );
}

function rowTop(bounds: string): number {
    const top = /^\[\d+,(\d+)\]/u.exec(bounds)?.[1];
    if (!top) throw new Error('Synthetic Session row bounds are unavailable');
    return Number(top);
}

async function currentRowTop(serial: string, id: string): Promise<number> {
    const nodes = await mobileSemantics(serial);
    const row = nodes.find(({ checkId }) => checkId === `session-row-${id}`);
    if (!row) throw new Error('Synthetic Session row is unavailable');
    return rowTop(row.bounds);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument.
test('captures three synthetic Session states before the dashboard Query migration', async ({}) => {
    test.skip(!serial, 'Run only with the explicitly owned Android emulator');
    const environment = requireEnvironment();
    const originalDisplay = await mobileDisplayState(environment.serial);
    const fixture = await createMobileDashboardParityFixture(environment.serial);
    const sessionIds = Object.values(fixture.sessionIds);
    const remoteVideoPath = '/sdcard/caxri-dashboard-parity.mp4';
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.pair();
        await waitForRows(environment.serial, sessionIds);
        await captureMobileFramebuffer(
            environment.serial,
            join(environment.assetsDirectory, 'phone-list.png'),
        );

        await tapMobileCheck(environment.serial, `session-row-${fixture.sessionIds.completed}`);
        await showConversation(environment.serial);
        await captureMobileFramebuffer(
            environment.serial,
            join(environment.assetsDirectory, 'phone-detail-conversation.png'),
        );
        await tapMobileCheck(environment.serial, 'session-detail-back');
        await waitForRows(environment.serial, sessionIds);

        await adbShell(environment.serial, ['wm', 'size', '1600x2560']);
        await adbShell(environment.serial, ['wm', 'density', '320']);
        await launchMobile(environment.serial);
        await waitForRows(environment.serial, sessionIds);
        await tapMobileCheck(environment.serial, `session-row-${fixture.sessionIds.completed}`);
        await showConversation(environment.serial);
        await captureMobileFramebuffer(
            environment.serial,
            join(environment.assetsDirectory, 'tablet-split-conversation.png'),
        );

        await restoreMobileDisplayState(environment.serial, originalDisplay);
        await launchMobile(environment.serial);
        await waitForRows(environment.serial, sessionIds);
        const runningRowTopBefore = await currentRowTop(
            environment.serial,
            fixture.sessionIds.running,
        );
        recording = await startMobileFramebufferRecording(environment.serial, remoteVideoPath);
        await waitForMobile(
            async () => {
                try {
                    return await adbShell(environment.serial, ['pidof', 'screenrecord']);
                } catch {
                    return '';
                }
            },
            (pid) => pid.length > 0,
            5_000,
        );
        const transition = await fixture.triggerRunningToWaiting();
        await waitForMobile(
            () => currentRowTop(environment.serial, fixture.sessionIds.running),
            (top) => top < runningRowTopBefore,
            12_000,
        );
        const mobileObservedAt = Date.now();
        await captureMobileFramebuffer(
            environment.serial,
            join(environment.assetsDirectory, 'phone-after-waiting.png'),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await recording.stop();
        recording = undefined;
        await pullMobileFramebufferRecording(
            environment.serial,
            remoteVideoPath,
            join(environment.assetsDirectory, 'running-to-waiting.mp4'),
        );
        await writeFile(
            environment.receiptPath,
            `${JSON.stringify(
                {
                    capture: 'local-pre-query-parity',
                    displayAfter: await mobileDisplayState(environment.serial),
                    displayBefore: originalDisplay,
                    mobileObservedDurationMs: mobileObservedAt - transition.triggeredAt,
                    states: ['waiting', 'running', 'completed', 'running-to-waiting'],
                    timingMethod: 'content-free-UIAutomator-row-position',
                    videoStartsOn: 'phone-session-list',
                    zeroWidthFixtureTitles: true,
                },
                null,
                2,
            )}\n`,
            'utf8',
        );
    } finally {
        await recording?.stop();
        await restoreMobileDisplayState(environment.serial, originalDisplay);
        await fixture.stop();
    }
});
