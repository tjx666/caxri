import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    androidBounds,
    copyMobileFramebufferRecording,
    mobileSemantics,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
} from './mobile-android';
import type { GrayFrame } from './mobile-motion-analysis';
import {
    departuresFromFinalPicture,
    heldPicturesBeforeFinalAt,
    readRecordingBand,
} from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A blip shorter than the Reconnecting notice's settle delay (`CONNECTION_NOTICE_SETTLE_MS`) but as long as the old
 * two-second delay, so the phone's reconnect, which starts the moment Android reports the network back, lands in the
 * window where the notice used to drop in and vanish.
 */
const BLIP_MS = 2_000;
/**
 * How long a segment is filmed after the network returns: past the settle delay, so a notice that does settle is on
 * film, and past the hold of one that was drawn.
 */
const WATCH_AFTER_MS = 8_000;
/**
 * An outage long enough that the notice must appear: the settle delay plus margin for the phone to notice the drop.
 */
const OUTAGE_MS = 9_000;
/**
 * How long the network stays back between two drops on a flaky network: shorter than the notice's hold, so the notice
 * must stay on screen through it.
 */
const FLAP_GAP_MS = 1_500;
/**
 * How long Caxri stays in the background before the user returns, like switching to another app for a moment.
 */
const BACKGROUND_MS = 4_000;
/**
 * Shortest hold that a reader sees as a separate picture.
 */
const HOLD_MS = 80;

type Recording = Awaited<ReturnType<typeof startMobileFramebufferRecording>>;

/**
 * `MOB-SESSION-NOTICE-RECONNECT-01`: a paired phone on the live Session list (#3750).
 *
 * 1. A two-second network blip must not drop the Reconnecting notice in above the list and take it away again, so the
 *    Project filter row holds still.
 * 2. A sustained outage still shows the notice, floating above the Project filter row without moving it (#3759). The row
 *    holds one picture from the drop, through a flaky recovery, until after the network is back.
 * 3. Leaving Caxri for a few seconds and returning, the path the report filmed, keeps the row still after it first
 *    appears.
 *
 * The runner keeps only the last recording, so each segment is analysed as soon as it stops and the resume segment
 * stays as the evidence video.
 */
export async function executeMobileHomeReconnectNoticeScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-SESSION-NOTICE-RECONNECT-01 judges each segment from its recording');
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Recording | undefined;
    const network = { isOffline: false };
    const setOnline = async (isOnline: boolean): Promise<void> => {
        await setMobileNetworkAvailable(serial, isOnline);
        network.isOffline = !isOnline;
    };
    try {
        if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        const row = `session-row-${fixture.allowedSessionId}`;
        await waitForCheck(serial, row);
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
        const filters = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === 'session-project-filters',
        );
        const band = filters && androidBounds(filters.bounds);
        if (!band) throw new Error('The Project filter row is not laid out');
        await capture(environment, 'live-list', artifacts);

        /**
         * Films `act`, then decodes the Project filter row's band from that recording.
         */
        const filmBand = async (act: () => Promise<void>): Promise<GrayFrame[]> => {
            recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
            await act();
            await recording.stop();
            recording = undefined;
            const analysis = await mkdtemp(join(tmpdir(), 'caxri-reconnect-notice-'));
            try {
                const video = join(analysis, 'segment.mp4');
                await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
                return (await readRecordingBand(video, band)).frames;
            } finally {
                await rm(analysis, { force: true, recursive: true });
            }
        };
        const summarize = (held: ReturnType<typeof heldPicturesBeforeFinalAt>): string =>
            JSON.stringify(
                held.map(({ heldMs, time }) => ({
                    heldMs: Math.round(heldMs),
                    timeMs: Math.round(time),
                })),
            );

        // 1. Blip.
        const blip = heldPicturesBeforeFinalAt(
            await filmBand(async () => {
                await pause(1_000);
                await setOnline(false);
                await pause(BLIP_MS);
                await setOnline(true);
                await pause(WATCH_AFTER_MS);
            }),
            HOLD_MS,
        );
        if (blip.length > 0)
            throw new Error(
                `The Project filter row moved during a ${BLIP_MS}ms network blip: ${summarize(blip)}`,
            );
        await capture(environment, 'after-blip', artifacts);

        // 2. Sustained outage, then a flaky recovery, filmed from the moment the network drops.
        const island = { bottom: 0, filtersTop: 0 };
        const flap = heldPicturesBeforeFinalAt(
            await filmBand(async () => {
                await pause(500);
                await setOnline(false);
                await pause(OUTAGE_MS);
                await waitForCheck(serial, 'connection-stale-banner', 30_000);
                const nodes = await mobileSemantics(serial);
                const bounds = (id: string) => {
                    const node = nodes.find(({ checkId }) => checkId === id);
                    return node && androidBounds(node.bounds);
                };
                const capsule = bounds('connection-stale-banner');
                const shifted = bounds('session-project-filters');
                if (!capsule || !shifted) throw new Error('The outage screen is not laid out');
                island.bottom = capsule.bottom;
                island.filtersTop = shifted.top;
                if (shifted.top !== band.top || shifted.bottom !== band.bottom)
                    throw new Error(
                        `The Reconnecting notice moved the Project filter row from ${band.top} to ${shifted.top}`,
                    );
                if (capsule.bottom > band.top)
                    throw new Error('The Reconnecting notice covers the Project filter row');
                await capture(environment, 'sustained-outage', artifacts);
                await setOnline(true);
                await pause(FLAP_GAP_MS);
                await setOnline(false);
                await pause(BLIP_MS);
                await setOnline(true);
                await pause(WATCH_AFTER_MS);
            }),
            HOLD_MS,
        );
        // The notice floats over the screen, so the row must show one picture from the drop until after recovery.
        if (flap.length > 0)
            throw new Error(
                `The Project filter row moved while the Reconnecting notice came and went: ${summarize(flap)}`,
            );
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
        await waitForCheck(serial, row);
        await capture(environment, 'recovered', artifacts);

        // 3. Background and return. Filming starts in the background so the launcher precedes the list's first frame.
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_HOME']);
        /**
         * The key event returns before the launcher animates in; a recording started then opens on the list itself, and
         * every launcher frame after it reads as the row leaving its final picture.
         */
        await waitForNoCheck(serial, row, 10_000);
        await pause(1_000);
        const resume = departuresFromFinalPicture(
            await filmBand(async () => {
                await pause(BACKGROUND_MS);
                await adbShell(serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
                await pause(WATCH_AFTER_MS);
            }),
        );
        if (resume.departures > 0)
            throw new Error(
                `The Project filter row moved ${resume.departures} frames after returning from the background`,
            );
        await capture(environment, 'after-resume', artifacts);

        await finish(environment, artifacts, {
            blipHeldPictures: blip.length,
            blipMs: BLIP_MS,
            flapGapMs: FLAP_GAP_MS,
            flapHeldPictures: flap.length,
            islandBottomPx: island.bottom,
            filterRowTopPx: island.filtersTop,
            outageMs: OUTAGE_MS,
            resumeDepartures: resume.departures,
            status: 'passed',
        });
    } finally {
        if (network.isOffline) await setMobileNetworkAvailable(serial, true);
        await recording?.stop();
        await fixture.stop();
    }
}
