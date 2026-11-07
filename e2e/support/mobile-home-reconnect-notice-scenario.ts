import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    androidBounds,
    copyMobileFramebufferRecording,
    mobileSemantics,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
} from './mobile-android';
import { heldPicturesBeforeFinalAt, readRecordingBand } from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A blip shorter than the Reconnecting notice's settle delay (`CONNECTION_NOTICE_SETTLE_MS`) but longer than the old
 * two-second delay, so the phone's reconnect, which starts the moment Android reports the network back, lands in the
 * window where the notice used to drop in and vanish.
 */
const BLIP_MS = 2_000;
/**
 * How long the list is filmed after the network returns: past the settle delay, so a notice that does settle is on
 * film, and past the hold of one that was drawn.
 */
const WATCH_AFTER_BLIP_MS = 8_000;
/**
 * An outage long enough that the notice must appear: the settle delay plus margin for the phone to notice the drop.
 */
const OUTAGE_MS = 9_000;
/**
 * Shortest hold that a reader sees as a separate picture.
 */
const HOLD_MS = 80;

/**
 * `MOB-SESSION-NOTICE-RECONNECT-01`: a paired phone on the live Session list loses its network for two seconds. The
 * Reconnecting notice must not drop in above the list and vanish again, so the Project filter row holds still for the
 * whole blip (#3750). A sustained outage afterwards must still show the notice, and it must clear once the network
 * returns.
 */
export async function executeMobileHomeReconnectNoticeScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-SESSION-NOTICE-RECONNECT-01 judges the blip from its recording');
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    let isOffline = false;
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

        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(1_000);
        await setMobileNetworkAvailable(serial, false);
        isOffline = true;
        await pause(BLIP_MS);
        await setMobileNetworkAvailable(serial, true);
        isOffline = false;
        await pause(WATCH_AFTER_BLIP_MS);
        await recording.stop();
        recording = undefined;

        const analysis = await mkdtemp(join(tmpdir(), 'caxri-reconnect-notice-'));
        let held: ReturnType<typeof heldPicturesBeforeFinalAt>;
        let frameCount: number;
        try {
            const video = join(analysis, 'blip.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            const { frames } = await readRecordingBand(video, band);
            frameCount = frames.length;
            held = heldPicturesBeforeFinalAt(frames, HOLD_MS);
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
        if (held.length > 0)
            throw new Error(
                `The Project filter row moved during a ${BLIP_MS}ms network blip: ${JSON.stringify(
                    held.map(({ heldMs, time }) => ({
                        heldMs: Math.round(heldMs),
                        timeMs: Math.round(time),
                    })),
                )}`,
            );
        await capture(environment, 'after-blip', artifacts);

        await setMobileNetworkAvailable(serial, false);
        isOffline = true;
        await pause(OUTAGE_MS);
        await waitForCheck(serial, 'connection-stale-banner', 30_000);
        await capture(environment, 'sustained-outage', artifacts);
        await setMobileNetworkAvailable(serial, true);
        isOffline = false;
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
        await waitForCheck(serial, row);
        await capture(environment, 'recovered', artifacts);

        await finish(environment, artifacts, {
            blipMs: BLIP_MS,
            blipFrames: frameCount,
            heldPicturesDuringBlip: held.length,
            outageMs: OUTAGE_MS,
            status: 'passed',
        });
    } finally {
        if (isOffline) await setMobileNetworkAvailable(serial, true);
        await recording?.stop();
        await fixture.stop();
    }
}
