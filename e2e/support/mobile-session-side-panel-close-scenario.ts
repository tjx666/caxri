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
 * Where the open drawer begins, as a share of the width.
 */
const DRAWER_LEFT = 0.12;
/**
 * The last part of the drawer's travel, as a share of its width. Once only this sliver remains on screen, too little of
 * the drawer is left to match, so those frames are not judged.
 */
const DRAWER_TAIL = 0.15;
/**
 * Pixels closer than this to the background are treated as empty, which removes video compression noise.
 */
const INK_FLOOR = 24;
/**
 * Smallest share of the open drawer's ink that a moving frame must reproduce at the drawer's offset. A drawer that
 * slides as one opaque picture reproduces nearly all of it; one that lost its own and its controls' backgrounds
 * reproduces about half.
 */
const MIN_DRAWER_MATCH = 0.75;
/**
 * Below this share no part of the drawer is on screen any more: the frame only shows the scrim's last fade over the
 * Session. A drawer that lost its backgrounds still reproduces about half its ink, so it stays well above this.
 */
const DRAWER_GONE = 0.2;
/**
 * Smallest brightness difference between the open and closed scrim strip that the fade judgement can resolve.
 */
const MIN_SCRIM_SPAN = 6;
/**
 * Mean absolute luma difference above which two pictures differ.
 */
const DIFFERENT_PICTURE = 2;

const columnsDifference = (
    a: GrayFrame,
    b: GrayFrame,
    { height, width }: FrameGeometry,
    from: number,
    to: number,
): number => {
    let sum = 0;
    for (let row = 0; row < height; row += 1)
        for (let column = from; column < to; column += 1) {
            const index = row * width + column;
            sum += Math.abs(a.data[index] - b.data[index]);
        }
    return sum / (height * (to - from));
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

/**
 * The open drawer's ink pixels as row-major indices, and the best share of them a frame reproduces at any rightward
 * offset.
 */
const drawerMatcher = (opened: GrayFrame, { height, width }: FrameGeometry, background: number) => {
    const left = Math.ceil(width * DRAWER_LEFT);
    const isInk = (value: number) => Math.abs(value - background) > INK_FLOOR;
    const ink: Array<{ column: number; row: number }> = [];
    for (let row = 0; row < height; row += 1)
        for (let column = left; column < width; column += 1)
            if (isInk(opened.data[row * width + column])) ink.push({ column, row });
    /**
     * The share of the open drawer's ink a frame shows at `offset`, or `null` once too little of the drawer is left on
     * screen to judge.
     */
    const matchAt = (data: Uint8Array, offset: number): number | null => {
        const shown = ink.filter(({ column }) => column + offset < width);
        if (shown.length < ink.length * DRAWER_TAIL) return null;
        const matched = shown.filter(({ column, row }) =>
            isInk(data[row * width + column + offset]),
        ).length;
        return matched / shown.length;
    };
    return ({ data }: GrayFrame): number => {
        let best = 0;
        for (let offset = 0; offset < width - left; offset += 1) {
            const match = matchAt(data, offset);
            if (match === null) break;
            best = Math.max(best, match);
        }
        return best;
    };
};

/**
 * Judges one recorded close of the phone drawer. The first frame shows the drawer open and the last shows it closed.
 *
 * - `movingFrames`: frames whose drawer area matches neither settled picture, so something visibly moves.
 * - `tornFrames`: moving frames in which part of the drawer is still on screen but no longer reads as one picture at any
 *   offset. The drawer and the Session share a background colour, so a drawer that lost its backgrounds looks the same
 *   size; what gives it away is that the selected tab and filter pills lose their fills and the Session's text shows
 *   through between the drawer's.
 * - `scrimFadeFrames`: frames whose scrim strip sits between its open and closed brightness.
 *
 * The close animation runs 220 ms and `screenrecord` delivers roughly 30 to 60 frames a second while the screen
 * changes, so a real slide or fade spans several frames; three moving and two fading frames are conservative floors.
 */
export function analyseDrawerClose(
    frames: readonly GrayFrame[],
    geometry: FrameGeometry,
): { movingFrames: number; scrimFadeFrames: number; scrimSpan: number; tornFrames: number } {
    const [opened] = frames;
    const closed = frames.at(-1);
    if (!closed) throw new Error('Recording has no frames');
    const { width } = geometry;
    const stripTo = Math.max(1, Math.floor(width * SCRIM_STRIP));
    const left = Math.ceil(width * DRAWER_LEFT);
    const tailFrom = width - Math.floor((width - left) * DRAWER_TAIL);
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
    const drawerMatch = drawerMatcher(opened, geometry, backgroundOf(closed));
    const moving = frames.filter(
        (frame) =>
            columnsDifference(frame, opened, geometry, left, width) > DIFFERENT_PICTURE &&
            columnsDifference(frame, closed, geometry, left, tailFrom) > DIFFERENT_PICTURE,
    );
    const tornFrames = moving.filter((frame) => {
        const match = drawerMatch(frame);
        return match >= DRAWER_GONE && match < MIN_DRAWER_MATCH;
    }).length;
    return { movingFrames: moving.length, scrimFadeFrames, scrimSpan: span, tornFrames };
}

/**
 * `MOB-SIDE-PANEL-PHONE-03`: tapping the phone drawer's close button slides the drawer out to the right while its scrim
 * fades, the reverse of opening it. When the drawer relied on Reanimated's `exiting` animation, Android dropped the
 * drawer's and the scrim's backgrounds as soon as they unmounted, so the drawer's text slid away over the Session as a
 * transparent ghost.
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
        const { movingFrames, scrimFadeFrames, scrimSpan, tornFrames } = analyseDrawerClose(
            frames,
            geometry,
        );
        await concludeScenario(
            environment,
            artifacts,
            {
                frames: frames.length,
                motion: 'live',
                movingFrames,
                scrimFadeFrames,
                scrimSpan: Number(scrimSpan.toFixed(1)),
                tornFrames,
            },
            {
                'the drawer moves over several frames': movingFrames >= 3,
                'the scrim fades over several frames': scrimFadeFrames >= 2,
                'the drawer slides out as one opaque picture': tornFrames === 0,
            },
        );
    } finally {
        await rm(analysis, { force: true, recursive: true });
        await fixture.stop();
    }
}
