import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { androidScreenSize } from '../../scripts/mobile-android-display-state.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    androidBounds,
    coldStartMobileApp,
    copyMobileFramebufferRecording,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { setEmulatorNetworkDelay } from './mobile-android-network';
import type { GrayFrame } from './mobile-motion-analysis';
import { readRecordingBand } from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WATCH_MS = 1_500;
/**
 * Round-trip latency each recorded open pays, as a phone does over the Relay. The local gateway answers within one
 * frame, which hides the dimmed picture the case looks for.
 */
const RELAY_DELAY_MS = 400;
/**
 * Downscale for frame analysis; the Agent card labels stay several pixels tall.
 */
const SCALE = 4;
/**
 * Grayscale step that separates text and icons from the background, and a dimmed label from a lit one.
 */
const INK_STEP = 40;
/**
 * The sheet's header (title through the "Agent" label) sits this far above the first Agent card, in screen pixels. It
 * reads the same whether the cards are dimmed or not, so it locates the sliding sheet in each frame.
 */
const HEADER_ABOVE_CARDS = { bottom: 17, top: 267 } as const;
/**
 * Share of the header's ink a frame may miss and still count as showing the sheet at that offset.
 */
const HEADER_MATCH = 0.05;
/**
 * Share of the Agent band's ink that must differ from the settled picture for a frame to count as dimmed. A dimmed
 * frame missed 92% in the baseline recording; every aligned settled frame missed none.
 */
const DIMMED_SHARE = 0.2;

interface Rows {
    bottom: number;
    top: number;
}

/**
 * Share of ink pixels in `rows` of the settled picture that `frame` shows differently when moved down by `shift` rows.
 * Only rows still on screen at that shift count.
 */
const inkMismatch = (
    frame: GrayFrame,
    settled: GrayFrame,
    width: number,
    height: number,
    background: number,
    rows: Rows,
    shift: number,
): number => {
    let ink = 0;
    let wrong = 0;
    for (let y = rows.top; y < rows.bottom && y + shift < height; y += 1)
        for (let x = 0; x < width; x += 1) {
            const expected = settled.data[y * width + x];
            const actual = frame.data[(y + shift) * width + x];
            const isInk =
                Math.abs(expected - background) >= INK_STEP ||
                Math.abs(actual - background) >= INK_STEP;
            if (isInk) ink += 1;
            if (isInk && Math.abs(actual - expected) >= INK_STEP) wrong += 1;
        }
    return ink === 0 ? 1 : wrong / ink;
};

/**
 * The frames of one open that show New Session's Agent band differently from where it settled. The sheet slides up as
 * it opens, so each frame is first aligned on the sheet's header; a frame whose header is not on screen yet still shows
 * the Session list and is skipped. Aligned, a frame that slides in the settled cards matches them, while one that
 * slides in dimmed "Checking availability…" cards, or lacks the Open as group, does not.
 */
const dimmedFrames = async (video: string, screenHeight: number, band: Rows) => {
    const { frames, geometry } = await readRecordingBand(
        video,
        { bottom: screenHeight, top: 0 },
        SCALE,
    );
    const settled = frames.at(-1);
    if (!settled) throw new Error('The open recording has no frames');
    const { height, width } = geometry;
    const scaled = (rows: Rows): Rows => ({
        bottom: Math.round(rows.bottom / SCALE),
        top: Math.round(rows.top / SCALE),
    });
    const header = scaled({
        bottom: band.top - HEADER_ABOVE_CARDS.bottom,
        top: band.top - HEADER_ABOVE_CARDS.top,
    });
    const cards = scaled(band);
    const background = settled.data[cards.top * width + 1];
    const dimmed: Array<{ share: number; time: number }> = [];
    for (const frame of frames) {
        let best = { mismatch: 1, shift: 0 };
        for (let shift = 0; header.bottom + shift <= height; shift += 1) {
            const mismatch = inkMismatch(frame, settled, width, height, background, header, shift);
            if (mismatch < best.mismatch) best = { mismatch, shift };
        }
        if (best.mismatch > HEADER_MATCH) continue;
        const share = inkMismatch(frame, settled, width, height, background, cards, best.shift);
        if (share >= DIMMED_SHARE)
            dimmed.push({ share: Number(share.toFixed(3)), time: Math.round(frame.time) });
    }
    return dimmed;
};
/**
 * The reconnect after a cold start, before New Session can read availability at all.
 */
const RECONNECT_MS = 60_000;

const isSettled = (nodes: MobileSemanticNode[]): boolean =>
    nodes.some(({ checkId, enabled }) => checkId === 'new-session-agent-claude' && enabled) &&
    nodes.some(({ checkId }) => checkId === 'new-session-surface-chat');

/**
 * Records one tap on + from the Session list until New Session has settled, and returns the settled semantics.
 */
const recordOpen = async (
    serial: string,
    remotePath: string,
    localPath: string,
): Promise<MobileSemanticNode[]> => {
    const recording = await startMobileFramebufferRecording(serial, remotePath);
    let settled: MobileSemanticNode[];
    try {
        await pause(WATCH_MS);
        await tapMobileCheck(serial, 'new-session-button');
        settled = await waitForMobile(() => mobileSemantics(serial), isSettled);
        await pause(WATCH_MS);
    } finally {
        await recording.stop();
    }
    await copyMobileFramebufferRecording(serial, remotePath, localPath);
    return settled;
};

const backToList = async (serial: string): Promise<void> => {
    await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'new-session-button'),
    );
};

/**
 * `MOB-NEW-OPEN-01`: opening New Session again must show the Agent cards and the Open as group as the phone last saw
 * them, instead of dimming every card to "Checking availability…" and inserting Open as one round trip later. The phone
 * saves each live availability answer for its pairing and shows it while the new read is in flight.
 *
 * The first open after pairing has nothing saved: it is the control and must show the dimmed picture, or the probe
 * could not see the defect at all. The second open is the claim within one app run; the third follows a cold start, so
 * the answer must come from the phone's saved copy rather than memory. In each recording the band from the first Agent
 * card to the bottom of the Open as group is compared with New Session's settled picture, frame by frame as the sheet
 * slides up (see {@link dimmedFrames}).
 */
export async function executeMobileNewSessionOpenScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('MOB-NEW-OPEN-01 judges each open from its recording');
    const fixture = await createMobileAcceptanceFixture({ mode: 'conversation', serial });
    const analysis = await mkdtemp(join(tmpdir(), 'caxri-new-session-open-'));
    let isDelayed = false;
    try {
        if (!fixture.allowedSessionId) throw new Error('The allowed Session is unavailable');
        const row = `session-row-${fixture.allowedSessionId}`;
        await fixture.pair();
        await setEmulatorNetworkDelay(serial, RELAY_DELAY_MS);
        isDelayed = true;
        const firstVideo = join(analysis, 'first-open.mp4');
        const settled = await recordOpen(serial, remoteVideoPath, firstVideo);
        const top = settled.find(({ checkId }) => checkId === 'new-session-agent-claude');
        const bottom = settled.find(({ checkId }) => checkId === 'new-session-surface-chat');
        const topBounds = top && androidBounds(top.bounds);
        const bottomBounds = bottom && androidBounds(bottom.bounds);
        if (!topBounds || !bottomBounds) throw new Error('New Session cards are not laid out');
        const band = { bottom: bottomBounds.bottom, top: topBounds.top };
        await backToList(serial);
        const secondVideo = join(analysis, 'second-open.mp4');
        await recordOpen(serial, remoteVideoPath, secondVideo);
        await capture(environment, 'second-open-settled', artifacts);
        await backToList(serial);
        await pause(WATCH_MS);
        await coldStartMobileApp(serial);
        // The row alone can come from the saved Session list; wait until a live read replaced it as well.
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === row) &&
                nodes.every(({ checkId }) => checkId !== 'session-list-saved'),
            RECONNECT_MS,
        );
        await pause(WATCH_MS);
        const thirdVideo = join(analysis, 'after-restart-open.mp4');
        await recordOpen(serial, remoteVideoPath, thirdVideo);
        await capture(environment, 'after-restart-open-settled', artifacts);
        await setEmulatorNetworkDelay(serial, 0);
        isDelayed = false;
        const screenHeight = androidScreenSize(await adbShell(serial, ['wm', 'size'])).height;
        const firstOpen = await dimmedFrames(firstVideo, screenHeight, band);
        const secondOpen = await dimmedFrames(secondVideo, screenHeight, band);
        const afterRestart = await dimmedFrames(thirdVideo, screenHeight, band);
        if (firstOpen.length === 0)
            throw new Error(
                'The first open showed no dimmed frame, so this recording cannot see the defect',
            );
        const describe = (pictures: typeof firstOpen) =>
            pictures.map(({ share, time }) => `${time} ms (${share})`).join(', ');
        if (secondOpen.length > 0 || afterRestart.length > 0)
            throw new Error(
                `Opening New Session again showed dimmed frames: second open [${describe(secondOpen)}], after restart [${describe(afterRestart)}]; first open control [${describe(firstOpen)}]`,
            );
        await finish(environment, artifacts, {
            afterRestartDimmedFrames: 0,
            firstOpenDimmedFrames: firstOpen,
            relayDelayMs: RELAY_DELAY_MS,
            secondOpenDimmedFrames: 0,
            status: 'passed',
        });
    } finally {
        if (isDelayed) await setEmulatorNetworkDelay(serial, 0);
        await rm(analysis, { force: true, recursive: true });
        await fixture.stop();
    }
}
