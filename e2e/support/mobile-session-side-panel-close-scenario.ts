import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    copyMobileFramebufferRecording,
    mobileDisplayState,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import type { MobileAndroidCaseEnvironment } from './mobile-android-case-registry';
import { requireRemoteVideoPath } from './mobile-android-case-registry';
import { seedMobileChangesFixture } from './mobile-changes-fixture';
import type { FrameGeometry, GrayFrame } from './mobile-motion-analysis';
import { readRecordingBand } from './mobile-motion-analysis';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT = 'Summarize the pending changes';
const LAST_NARRATION = 'The three changed files are listed in Changes.';

/**
 * A short finished turn, so the Chat under the drawer carries text and nothing on screen keeps animating: with live
 * motion an endless spinner would stop every UIAutomator read.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                { kind: 'text', text: 'Reading the working tree for changed files.' },
                { kind: 'text', text: LAST_NARRATION },
            ],
        },
    ],
};

const isFinished = (snapshot: AgentChatSnapshot): boolean =>
    !snapshot.activeTurnId &&
    snapshot.items.some((item) => item.type === 'agentMessage' && item.text === LAST_NARRATION);

/**
 * The drawer is 88% of a phone's width, so the left tenth shows only the scrim over the Session.
 */
const SCRIM_STRIP = 0.1;
/**
 * The drawer itself, right of the scrim strip with a margin for its border.
 */
const DRAWER_FROM = 0.15;
/**
 * Pixels closer than this to the background are treated as empty, which removes video compression noise.
 */
const INK_FLOOR = 24;
/**
 * A frame whose drawer region carries this much more ink than both settled pictures shows two layers of text at once.
 */
const GHOST_RATIO = 1.2;
/**
 * Smallest brightness difference between the open and closed scrim strip that the fade judgement can resolve.
 */
const MIN_SCRIM_SPAN = 6;
/**
 * Mean absolute luma difference over the drawer region above which a frame shows a picture other than a settled one.
 */
const DIFFERENT_PICTURE = 2;

const regionDifference = (
    a: GrayFrame,
    b: GrayFrame,
    { height, width }: FrameGeometry,
    from: number,
): number => {
    let sum = 0;
    for (let row = 0; row < height; row += 1)
        for (let column = from; column < width; column += 1) {
            const index = row * width + column;
            sum += Math.abs(a.data[index] - b.data[index]);
        }
    return sum / (height * (width - from));
};

const columnsMean = (
    { data }: GrayFrame,
    { height, width }: FrameGeometry,
    from: number,
    to: number,
): number => {
    let sum = 0;
    for (let row = 0; row < height; row += 1)
        for (let column = from; column < to; column += 1) sum += data[row * width + column];
    return sum / (height * (to - from));
};

const backgroundOf = ({ data }: GrayFrame): number => {
    const histogram = new Uint32Array(256);
    for (const value of data) histogram[value] += 1;
    let mode = 0;
    for (let value = 1; value < 256; value += 1)
        if (histogram[value] > histogram[mode]) mode = value;
    return mode;
};

const inkShare = (
    { data }: GrayFrame,
    { height, width }: FrameGeometry,
    from: number,
    background: number,
): number => {
    let ink = 0;
    for (let row = 0; row < height; row += 1)
        for (let column = from; column < width; column += 1)
            if (Math.abs(data[row * width + column] - background) > INK_FLOOR) ink += 1;
    return ink / (height * (width - from));
};

/**
 * Judges one recorded close of the phone drawer.
 *
 * - `scrimFadeFrames`: frames whose scrim strip sits between its open and closed brightness. A scrim that fades shows
 *   several; one that vanishes with its view shows none.
 * - `ghostFrames`: frames whose drawer region carries far more ink than either settled picture. The drawer is opaque
 *   while it slides, so only a drawer that lost its background lets the Session's text show through its own.
 * - `transitionFrames`: frames whose drawer region matches neither settled picture, so the drawer is visibly moving.
 *
 * The close animation runs 220 ms and `screenrecord` delivers roughly 30 to 60 frames a second while the screen
 * changes, so a real fade or slide spans several frames; two fade frames and three moving frames are conservative
 * floors.
 */
export function analyseDrawerClose(
    frames: readonly GrayFrame[],
    geometry: FrameGeometry,
): { ghostFrames: number; scrimFadeFrames: number; scrimSpan: number; transitionFrames: number } {
    const [opened] = frames;
    const closed = frames.at(-1);
    if (!closed) throw new Error('Recording has no frames');
    const stripTo = Math.max(1, Math.floor(geometry.width * SCRIM_STRIP));
    const drawerFrom = Math.floor(geometry.width * DRAWER_FROM);
    const openLevel = columnsMean(opened, geometry, 0, stripTo);
    const closedLevel = columnsMean(closed, geometry, 0, stripTo);
    const low = Math.min(openLevel, closedLevel);
    const span = Math.abs(closedLevel - openLevel);
    if (span < MIN_SCRIM_SPAN)
        throw new Error(
            `The scrim strip barely changes when the drawer closes (${span.toFixed(1)})`,
        );
    const scrimFadeFrames = frames.filter((frame) => {
        const level = columnsMean(frame, geometry, 0, stripTo);
        return level > low + span * 0.15 && level < low + span * 0.85;
    }).length;
    const background = backgroundOf(closed);
    const settledInk = Math.max(
        inkShare(opened, geometry, drawerFrom, background),
        inkShare(closed, geometry, drawerFrom, background),
    );
    const ghostFrames = frames.filter(
        (frame) => inkShare(frame, geometry, drawerFrom, background) > settledInk * GHOST_RATIO,
    ).length;
    const transitionFrames = frames.filter(
        (frame) =>
            regionDifference(frame, opened, geometry, drawerFrom) > DIFFERENT_PICTURE &&
            regionDifference(frame, closed, geometry, drawerFrom) > DIFFERENT_PICTURE,
    ).length;
    return { ghostFrames, scrimFadeFrames, scrimSpan: span, transitionFrames };
}

/**
 * `MOB-SIDE-PANEL-PHONE-03`: tapping the phone drawer's close button slides the drawer out to the right while its scrim
 * fades, the reverse of opening it. When the drawer relied on Reanimated's `exiting` animation, Android dropped the
 * drawer's and the scrim's backgrounds as soon as they unmounted, so the drawer's text slid away over the Session as a
 * transparent ghost and the scrim vanished in one frame.
 */
export async function executeMobileSidePanelCloseScenario(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const remoteVideoPath = requireRemoteVideoPath(environment);
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        seedProject: (root) => seedMobileChangesFixture(root, 'standard'),
        serial,
    });
    const analysis = await mkdtemp(join(tmpdir(), 'caxri-drawer-close-'));
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        await chat.send({ text: PROMPT });
        await waitForMobile(() => chat.read(), isFinished, 60_000);
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'session-panel-button', 60_000);
        await tapMobileCheck(serial, 'session-panel-button');
        await waitForCheck(serial, 'session-side-panel-close');
        await pause(1_000);
        await capture(environment, 'drawer-open', artifacts);
        const { size } = await mobileDisplayState(serial);
        const { height } = size.override ?? size.physical;
        // Below the status bar and above the navigation bar, which the app does not draw.
        const band = { top: Math.floor(height * 0.06), bottom: Math.floor(height * 0.94) };
        const recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        try {
            await pause(800);
            await tapMobileCheck(serial, 'session-side-panel-close');
            await pause(1_500);
        } finally {
            await recording.stop();
        }
        await waitForNoCheck(serial, 'session-side-panel');
        await capture(environment, 'drawer-closed', artifacts);
        const video = join(analysis, 'close.mp4');
        await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
        const { frames, geometry } = await readRecordingBand(video, band);
        const { ghostFrames, scrimFadeFrames, scrimSpan, transitionFrames } = analyseDrawerClose(
            frames,
            geometry,
        );
        await concludeScenario(
            environment,
            artifacts,
            {
                frames: frames.length,
                ghostFrames,
                motion: 'live',
                scrimFadeFrames,
                scrimSpan: Number(scrimSpan.toFixed(1)),
                transitionFrames,
            },
            {
                'the drawer moves over several frames': transitionFrames >= 3,
                'the scrim fades over several frames': scrimFadeFrames >= 2,
                'the drawer stays opaque while it slides out': ghostFrames === 0,
            },
        );
    } finally {
        await rm(analysis, { force: true, recursive: true });
        await fixture.stop();
    }
}
