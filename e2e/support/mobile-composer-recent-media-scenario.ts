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
    mobileNativeControlBounds,
    mobileSemantics,
    pushMobileFixture,
    tapMobileCheck,
    tapMobileCheckByBounds,
    tapMobileNativeControl,
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

/**
 * The permission prompt's full-access button on Android 14 and later ("Allow all").
 */
const ALLOW_ALL = 'com.android.permissioncontroller:id/permission_allow_all_button';

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

type Access = 'declined' | 'granted' | 'undetermined';

/**
 * The app's image and video permission as the package manager reports it, so a case proves its fixture took effect
 * instead of inferring it from the row alone.
 */
const readMediaPermissions = async (serial: string) => {
    const dump = await adbShell(serial, ['dumpsys', 'package', 'com.caxri.mobile']);
    const runtime = dump.slice(dump.indexOf('runtime permissions:'));
    const read = (name: string) => {
        const line = new RegExp(
            String.raw`${name}: granted=(true|false), flags=\[([^\]]*)\]`,
            'u',
        ).exec(runtime);
        return {
            granted: line?.[1] === 'true',
            userFixed: line?.[2]?.includes('USER_FIXED') ?? false,
        };
    };
    return {
        images: read('android.permission.READ_MEDIA_IMAGES'),
        video: read('android.permission.READ_MEDIA_VIDEO'),
    };
};

const assertMediaPermissions = async (serial: string, access: Access) => {
    const state = await readMediaPermissions(serial);
    const expected = {
        declined: { granted: false, userFixed: true },
        granted: { granted: true, userFixed: false },
        undetermined: { granted: false, userFixed: false },
    }[access];
    for (const permission of [state.images, state.video])
        if (permission.granted !== expected.granted || permission.userFixed !== expected.userFixed)
            throw new Error(`The ${access} photo library fixture did not take effect`);
    return state;
};

/**
 * The package owning the focused window, such as `com.android.permissioncontroller` while the system prompt shows.
 */
const focusedPackage = async (serial: string): Promise<string | undefined> => {
    const windows = await adbShell(serial, ['dumpsys', 'window', 'displays']);
    return /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)/u.exec(windows)?.[1];
};

const waitForRecentRow = (serial: string) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            hasCheck(nodes, 'image-source-recent-image') &&
            hasCheck(nodes, 'image-source-recent-video'),
        30_000,
    );

const openAddSheet = async (serial: string) => {
    await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
    await waitForCheck(serial, 'image-source-library');
};

/**
 * `MOB-COMPOSER-RECENT-MEDIA-01` (access granted): the Chat composer's add sheet shows the newest photo and video above
 * the sources, the video with its first frame and length; tapping the photo attaches it as an image, and tapping the
 * video attaches it as a file card. `-02` (declined): the sheet shows only its sources, with no system prompt. `-03`
 * (never asked): the sheet's first opening shows the system prompt, and allowing it fills the row.
 */
async function executeRecentMediaScenario(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
    access: Access,
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
        const before = await assertMediaPermissions(serial, access);
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');

        if (access === 'declined') {
            await openAddSheet(serial);
            // The library read settles well within this; a row or prompt appearing later still fails the checks below.
            await pause(2_000);
            const focus = await focusedPackage(serial);
            if (focus !== 'com.caxri.mobile')
                throw new Error('Another window took focus over the add sheet');
            if (hasCheck(await mobileSemantics(serial), 'image-source-recent'))
                throw new Error('The recent row showed without library access');
            await capture(environment, 'sheet-without-recent', artifacts);
            await finish(environment, artifacts, {
                focusedWindow: 'caxri',
                permissions: before,
                recentRow: 'hidden',
                status: 'passed',
            });
            return;
        }

        if (access === 'undetermined') {
            await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
            await waitForMobile(
                () => mobileNativeControlBounds(serial, { resourceId: ALLOW_ALL }),
                (bounds) => bounds !== null,
                30_000,
            );
            const focus = await focusedPackage(serial);
            await capture(environment, 'permission-prompt', artifacts);
            await tapMobileNativeControl(serial, { resourceId: ALLOW_ALL });
            await waitForRecentRow(serial);
            await pause(1_500);
            await capture(environment, 'sheet-after-allow', artifacts);
            await finish(environment, artifacts, {
                after: await assertMediaPermissions(serial, 'granted'),
                before,
                promptWindow: focus,
                recentRow: 'shown',
                status: 'passed',
            });
            return;
        }

        await openAddSheet(serial);
        await waitForRecentRow(serial);
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
        await openAddSheet(serial);
        await waitForRecentRow(serial);
        // The row appears while the sheet is still sliding up; bounds read mid-slide put the tap below the video.
        await pause(1_000);
        await tapMobileCheck(serial, 'image-source-recent-video');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId.startsWith('session-file-play-')) &&
                !hasCheck(nodes, 'image-source-sheet'),
            120_000,
        );
        await pause(1_000);
        await capture(environment, 'recent-media-attached', artifacts);
        await finish(environment, artifacts, {
            attached: ['recent-photo-as-image', 'recent-video-as-file'],
            permissions: before,
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

export const executeMobileComposerRecentMediaFirstAskScenario = (
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
) => executeRecentMediaScenario(environment, artifacts, 'undetermined');
