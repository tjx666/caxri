import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    pushMobileFixture,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import type { MobileAndroidCaseEnvironment } from './mobile-android-case-registry';
import { addMobileGalleryImages, removeMobileGalleryImages } from './mobile-gallery';

const run = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A seven-second clip, so its thumbnail carries a `0:07` length a reviewer can read.
 */
const VIDEO_NAME = 'caxri-recent-video.mp4';
const REMOTE_VIDEO = `/sdcard/Download/${VIDEO_NAME}`;

const rescanVideo = (serial: string) =>
    adbShell(serial, [
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${REMOTE_VIDEO}`,
    ]);

const addVideo = async (serial: string, directory: string) => {
    const path = join(directory, VIDEO_NAME);
    await run('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=orange:s=720x1280:d=7:r=30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        path,
    ]);
    await pushMobileFixture(serial, path, REMOTE_VIDEO);
    await rescanVideo(serial);
};

/**
 * `MOB-COMPOSER-RECENT-MEDIA-01` (library access granted): the Chat composer's add sheet shows the newest photo and
 * video above the sources, the video with its first frame and length; tapping the photo closes the sheet and attaches
 * it. `MOB-COMPOSER-RECENT-MEDIA-02` (access declined): the sheet shows only its sources, as before the row existed.
 */
async function executeRecentMediaScenario(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
    access: 'declined' | 'granted',
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-recent-'));
    try {
        await addMobileGalleryImages(serial);
        await addVideo(serial, directory);
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await waitForCheck(serial, 'image-source-library');

        if (access === 'declined') {
            // The library read settles well within this; a row appearing later would still fail the check below.
            await pause(2_000);
            if (hasCheck(await mobileSemantics(serial), 'image-source-recent'))
                throw new Error('The recent row showed without library access');
            await capture(environment, 'sheet-without-recent', artifacts);
            await finish(environment, artifacts, { recentRow: 'hidden', status: 'passed' });
            return;
        }

        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'image-source-recent-image') &&
                hasCheck(nodes, 'image-source-recent-video'),
            30_000,
        );
        // Lets the video's first frame decode before the row is judged.
        await pause(1_500);
        await capture(environment, 'sheet-with-recent', artifacts);
        await tapMobileCheck(serial, 'image-source-recent-image');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'session-image-open-0') &&
                !hasCheck(nodes, 'session-image-status-0') &&
                !hasCheck(nodes, 'image-source-sheet'),
            120_000,
        );
        await capture(environment, 'recent-photo-attached', artifacts);
        await finish(environment, artifacts, {
            attached: 'recent-photo',
            recentRow: 'shown',
            status: 'passed',
        });
    } finally {
        try {
            await removeMobileGalleryImages(serial);
            await adbShell(serial, ['rm', '-f', REMOTE_VIDEO]);
            await rescanVideo(serial);
            await rm(directory, { force: true, recursive: true });
        } finally {
            await fixture.stop();
        }
    }
}

export const executeMobileComposerRecentMediaScenario = (
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
) => executeRecentMediaScenario(environment, artifacts, 'granted');

export const executeMobileComposerRecentMediaDeclinedScenario = (
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
) => executeRecentMediaScenario(environment, artifacts, 'declined');
