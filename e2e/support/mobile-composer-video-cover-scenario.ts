import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    pushMobileFixture,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import type { MobileAndroidCaseEnvironment } from './mobile-android-case-registry';
import { requireRemoteVideoPath } from './mobile-android-case-registry';
import { pickMobileGalleryImages } from './mobile-gallery';

const run = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A portrait picture a reviewer can place at a glance: red, blue, and green thirds from top to bottom and a white
 * stripe down the start edge. A square cover cut from its middle shows blue between a white stripe and nothing else; a
 * rotated or misplaced frame shows the bands running sideways or the wrong color.
 */
const PICTURE = [
    'color=c=blue:s=720x1600:d=3:r=30',
    'drawbox=x=0:y=0:w=720:h=533:color=red:t=fill',
    'drawbox=x=0:y=1067:w=720:h=533:color=green:t=fill',
    'drawbox=x=0:y=0:w=120:h=1600:color=white:t=fill',
].join(',');

/**
 * Two ways a phone writes a portrait video: a screen recording stores portrait pixels, while a camera stores landscape
 * pixels with a rotation the player applies.
 */
const VIDEOS = [
    { name: 'caxri-cover-portrait.mp4', rotated: false },
    { name: 'caxri-cover-rotated.mp4', rotated: true },
] as const;

const remote = (name: string) => `/sdcard/Download/${name}`;

const encode = (filter: string, output: string) =>
    run('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        filter,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        output,
    ]);

const createVideos = async (directory: string): Promise<string[]> => {
    const [portrait, rotated] = VIDEOS.map(({ name }) => join(directory, name));
    await encode(PICTURE, portrait);
    // Landscape pixels, then a remux that tags them with the rotation turning them back upright.
    const landscape = join(directory, 'landscape.mp4');
    await encode(`${PICTURE},transpose=clock`, landscape);
    await run('ffmpeg', [
        '-loglevel',
        'error',
        '-display_rotation',
        '90',
        '-i',
        landscape,
        '-c',
        'copy',
        rotated,
    ]);
    return [portrait, rotated];
};

const rescan = (serial: string, name: string) =>
    adbShell(serial, [
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${remote(name)}`,
    ]);

/**
 * How long the strip rests after the recording starts, so the video opens on the settled composer before the removal.
 */
const RECORDING_LEAD_MS = 1000;

/**
 * `MOB-COMPOSER-VIDEO-COVER-01`: portrait videos attached from the gallery show their own first frame on the composer
 * card, upright and cut from the frame's middle, whether the file stores portrait pixels (a screen recording) or
 * landscape pixels with a rotation (a camera). Removing the cards one by one fades each away, the last one included,
 * while the composer settles back to its empty height; the removal is recorded.
 */
export async function executeMobileComposerVideoCoverScenario(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const remoteVideoPath = requireRemoteVideoPath(environment);
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-cover-'));
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const paths = await createVideos(directory);
        for (const [index, path] of paths.entries()) {
            const { name } = VIDEOS[index];
            // eslint-disable-next-line no-await-in-loop -- each push is followed by its own media scan.
            await pushMobileFixture(serial, path, remote(name));
            // eslint-disable-next-line no-await-in-loop -- see above.
            await rescan(serial, name);
        }
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');

        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await tapMobileCheck(serial, 'image-source-library');
        await pickMobileGalleryImages(serial, VIDEOS.length);
        const covered = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.filter(({ checkId }) => checkId.startsWith('session-file-play-')).length ===
                VIDEOS.length,
            120_000,
        );
        const ids = covered
            .filter(({ checkId }) => checkId.startsWith('session-file-remove-'))
            .map(({ checkId }) => checkId.slice('session-file-remove-'.length));
        if (ids.length !== VIDEOS.length) throw new Error('Not every video has a card');
        // Lets each cover finish decoding before the frame is judged.
        await pause(1_000);
        await capture(environment, 'covers', artifacts);

        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(RECORDING_LEAD_MS);
        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- the cards are removed one after the other.
            await tapMobileCheckByBounds(serial, `session-file-remove-${id}`);
            // eslint-disable-next-line no-await-in-loop -- see above.
            await waitForNoCheck(serial, `session-file-${id}`);
            // eslint-disable-next-line no-await-in-loop -- keeps each fade apart in the recording.
            await pause(800);
        }
        // Ends on a real interaction so the variable-rate recording carries the settled composer.
        const input = checkBounds(await mobileSemantics(serial), 'agent-chat-composer-input');
        if (input)
            await adbShell(serial, [
                'input',
                'tap',
                String(Math.round((input.left + input.right) / 2)),
                String(Math.round((input.top + input.bottom) / 2)),
            ]);
        await pause(800);
        await recording.stop();
        recording = undefined;
        await capture(environment, 'removed', artifacts);

        await finish(environment, artifacts, {
            covers: VIDEOS.length,
            removed: 'all',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        try {
            for (const { name } of VIDEOS) {
                // eslint-disable-next-line no-await-in-loop -- cleanup runs one file at a time.
                await adbShell(serial, ['rm', '-f', remote(name)]);
                // eslint-disable-next-line no-await-in-loop -- see above.
                await rescan(serial, name);
            }
            await rm(directory, { force: true, recursive: true });
        } finally {
            await fixture.stop();
        }
    }
}
