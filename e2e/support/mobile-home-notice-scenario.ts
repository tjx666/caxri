import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    androidBounds,
    copyMobileFramebufferRecording,
    mobileSemantics,
    startMobileFramebufferRecording,
} from './mobile-android';
import { setEmulatorNetworkDelay } from './mobile-android-network';
import type { GrayFrame } from './mobile-motion-analysis';
import { heldPicturesBeforeFinalAt, readRecordingBand } from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The read cache writes one second after the live view settles; this leaves room for that write before the app dies, so
 * the cold start opens on the saved Session list the way a returning phone does.
 */
const READ_CACHE_SETTLE_MS = 2_500;
/**
 * The round trips a phone pays over the Relay. On the local gateway the phone connects within a frame or two, too fast
 * to show the notices a real phone flashed for a few hundred milliseconds.
 */
const RELAY_DELAY_MS = 150;
/**
 * How long the cold start is filmed, past the notices' settle delay so a notice that does settle is on film.
 */
const WATCH_MS = 6_000;
/**
 * Shortest hold that a reader sees as a separate picture; the notices on the reporting phone held about 250ms.
 */
const HOLD_MS = 80;
/**
 * Luma spread under which the band is one flat color: the splash screen, before the app draws its header.
 */
const FLAT_SPREAD = 24;

const isFlat = ({ data }: GrayFrame): boolean => {
    let low = 255;
    let high = 0;
    for (const value of data) {
        if (value < low) low = value;
        if (value > high) high = value;
    }
    return high - low < FLAT_SPREAD;
};

/**
 * `MOB-SESSION-NOTICE-SETTLE-01`: a paired phone with a saved Session list is cold-started while the computer is
 * online. Neither the reconnecting notice nor the saved-copy notice may flash above the list while the first connection
 * and the first live list arrive, so the Project filter row holds its final position from its first frame (#3510).
 *
 * The filter row's settled band is judged from every recorded frame after the splash screen: any picture held there
 * other than the final one means something above it pushed the row down and back.
 */
export async function executeMobileHomeNoticeSettleScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-SESSION-NOTICE-SETTLE-01 judges the cold start from its recording');
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    let isDelayed = false;
    try {
        if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        const row = `session-row-${fixture.allowedSessionId}`;
        await waitForCheck(serial, row);
        const filters = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === 'session-project-filters',
        );
        const band = filters && androidBounds(filters.bounds);
        if (!band) throw new Error('The Project filter row is not laid out');
        await pause(READ_CACHE_SETTLE_MS);

        await adbShell(serial, ['am', 'force-stop', 'com.caxri.mobile']);
        await setEmulatorNetworkDelay(serial, RELAY_DELAY_MS);
        isDelayed = true;
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await adbShell(serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
        await pause(WATCH_MS);
        await recording.stop();
        recording = undefined;
        await setEmulatorNetworkDelay(serial, 0);
        isDelayed = false;
        await waitForCheck(serial, row);
        await capture(environment, 'cold-start-settled', artifacts);
        // The final picture must be the notice-free list, or a notice that settled late would pass as the final frame.
        const settled = await mobileSemantics(serial);
        const notices = ['connection-stale-banner', 'session-list-saved'].filter((id) =>
            settled.some(({ checkId }) => checkId === id),
        );
        if (notices.length > 0)
            throw new Error(`The settled Session list still shows ${notices.join(', ')}`);

        const analysis = await mkdtemp(join(tmpdir(), 'caxri-home-notice-'));
        try {
            const video = join(analysis, 'cold-start.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            const { frames } = await readRecordingBand(video, band);
            const splash = frames.findIndex(isFlat);
            if (splash === -1) throw new Error('The recording never showed the splash screen');
            const held = heldPicturesBeforeFinalAt(frames.slice(splash), HOLD_MS).map(
                ({ heldMs, time }) => ({
                    heldMs: Math.round(heldMs),
                    sinceSplashMs: Math.round(time - frames[splash].time),
                }),
            );
            if (held.length > 0)
                throw new Error(
                    `The Project filter row held ${held.length} other pictures before settling on cold start: ${JSON.stringify(held)}`,
                );
            await finish(environment, artifacts, {
                frames: frames.length - splash,
                heldPicturesBeforeFinal: held.length,
                relayDelayMs: RELAY_DELAY_MS,
                status: 'passed',
            });
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
    } finally {
        if (isDelayed) await setEmulatorNetworkDelay(serial, 0);
        await recording?.stop();
        await fixture.stop();
    }
}
