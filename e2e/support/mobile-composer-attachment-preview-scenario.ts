import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    pushMobileFixture,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    tapMobileNativeControl,
    waitForMobile,
} from './mobile-android';
import {
    addMobileGalleryImages,
    pickMobileGalleryImages,
    removeMobileGalleryImages,
} from './mobile-gallery';

const run = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO_NAME = 'caxri-acceptance-preview.mp4';
const REMOTE_VIDEO = `/sdcard/Download/${VIDEO_NAME}`;

/**
 * Ten seconds of FFmpeg's `testsrc`, whose moving counter shows the player is playing the picked file.
 */
const createVideo = async (directory: string): Promise<string> => {
    const video = join(directory, VIDEO_NAME);
    await run('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=10:size=640x360:rate=30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        video,
    ]);
    return video;
};

const rescan = (serial: string) =>
    adbShell(serial, [
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${REMOTE_VIDEO}`,
    ]);

/**
 * Leaves an open full-screen preview with the system Back gesture, which a playing video cannot block the way it hides
 * its own controls from UIAutomator.
 */
const closePreview = async (serial: string, id: string) => {
    await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
    await waitForNoCheck(serial, id);
};

/**
 * `MOB-COMPOSER-ATTACH-PREVIEW-01`: pending attachments preview from the phone's own copy whatever their upload state.
 * With the computer unreachable, a gallery image and a video picked from Files both fail to upload; the image still
 * opens full size and the video still plays, while each one's Retry opens the failure sheet. Back online, Retry uploads
 * the video and the ready card plays it again.
 */
export async function executeMobileComposerAttachmentPreviewScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-preview-'));
    const network = { isDisabled: false };
    const setNetwork = async (isAvailable: boolean) => {
        await setMobileNetworkAvailable(serial, isAvailable);
        network.isDisabled = !isAvailable;
        if (isAvailable) await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
    };
    try {
        await pushMobileFixture(serial, await createVideo(directory), REMOTE_VIDEO);
        await rescan(serial);
        await addMobileGalleryImages(serial);
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');

        // The picker is open when the network drops, so the image is attached but cannot upload.
        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await tapMobileCheck(serial, 'image-source-library');
        await setNetwork(false);
        await pickMobileGalleryImages(serial);
        await waitForCheck(serial, 'session-image-retry-0', 120_000);
        await capture(environment, 'image-failed', artifacts);
        await tapMobileCheckByBounds(serial, 'session-image-open-0');
        await waitForCheck(serial, 'agent-chat-image-viewer-image');
        await capture(environment, 'image-failed-viewer', artifacts);
        await closePreview(serial, 'agent-chat-image-viewer');
        await tapMobileCheckByBounds(serial, 'session-image-retry-0');
        await waitForCheck(serial, 'image-failure-sheet');
        await capture(environment, 'image-failed-sheet', artifacts);
        await tapMobileCheck(serial, 'image-failure-remove');
        await waitForNoCheck(serial, 'session-image-open-0');

        // Attaching needs the computer, so the network returns for the Files picker and drops again before the pick.
        await setNetwork(true);
        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await tapMobileCheck(serial, 'image-source-files');
        await setNetwork(false);
        await tapMobileNativeControl(serial, { text: VIDEO_NAME });
        const failed = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.some(({ checkId }) => checkId.startsWith('session-file-retry-')),
            120_000,
        );
        const fileId = failed
            .find(({ checkId }) => checkId.startsWith('session-file-retry-'))
            ?.checkId.slice('session-file-retry-'.length);
        if (!fileId) throw new Error('The video card did not fail');
        await capture(environment, 'video-failed', artifacts);
        await tapMobileCheckByBounds(serial, `session-file-${fileId}`);
        await waitForCheck(serial, 'agent-chat-video-player');
        // The player keeps the screen moving, so it is followed by time, not by UIAutomator.
        await pause(3_000);
        await capture(environment, 'video-failed-playing', artifacts);
        await closePreview(serial, 'agent-chat-video-player');
        await tapMobileCheckByBounds(serial, `session-file-retry-${fileId}`);
        await waitForCheck(serial, 'image-failure-sheet');
        await capture(environment, 'video-failed-sheet', artifacts);

        await setNetwork(true);
        await tapMobileCheck(serial, 'image-failure-retry');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId.startsWith('session-file-remove-')) &&
                nodes.every(({ checkId }) => !checkId.startsWith('session-file-retry-')) &&
                nodes.find(({ checkId }) => checkId === 'agent-chat-composer-send')?.enabled ===
                    true,
            90_000,
        );
        const ready = await mobileSemantics(serial);
        const readyId = ready
            .find(({ checkId }) => checkId.startsWith('session-file-remove-'))
            ?.checkId.slice('session-file-remove-'.length);
        if (!readyId || !hasCheck(ready, `session-file-${readyId}`))
            throw new Error('The uploaded video card is missing');
        await capture(environment, 'video-ready', artifacts);
        await tapMobileCheckByBounds(serial, `session-file-${readyId}`);
        await waitForCheck(serial, 'agent-chat-video-player');
        await pause(3_000);
        await capture(environment, 'video-ready-playing', artifacts);
        await closePreview(serial, 'agent-chat-video-player');

        await finish(environment, artifacts, {
            failedImage: 'viewer-and-retry-sheet',
            failedVideo: 'played-and-retry-sheet',
            readyVideo: 'played',
            status: 'passed',
        });
    } finally {
        if (network.isDisabled) {
            try {
                await setMobileNetworkAvailable(serial, true);
            } catch {
                // Teardown must still stop the fixture; the scenario's own failure is the useful error.
            }
        }
        try {
            await adbShell(serial, ['rm', '-f', REMOTE_VIDEO]);
            await rescan(serial);
            await removeMobileGalleryImages(serial);
            await rm(directory, { force: true, recursive: true });
        } finally {
            await fixture.stop();
        }
    }
}
