import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatTextWithPathReferences } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    checkBounds,
    scrollTimelineUntil,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileColorBounds,
    mobileRegionFingerprint,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const run = promisify(execFile);

/**
 * The synthetic video every case cites: 60 seconds of FFmpeg's `testsrc`, whose frame counter shows where playback is,
 * so a screenshot after a seek proves the scrub landed. It lives under `/tmp` rather than the fixture Project: the fake
 * Codex echoes the message, and the system temp directory holding the Project is account-specific, so a recording must
 * not show it. Server Core serves any path the message cites, inside a Project or not. It carries a tone because
 * Android routes media keys to the session that last played audio, and a silent video never becomes that session.
 */
const VIDEO_NAME = 'demo.mp4';
const VIDEO_SECONDS = 60;

const createVideo = async (): Promise<string> => {
    const directory = await mkdtemp('/tmp/caxri-video-');
    const video = join(directory, VIDEO_NAME);
    await run('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=${VIDEO_SECONDS}:size=640x360:rate=30`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${VIDEO_SECONDS}`,
        '-c:a',
        'aac',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        video,
    ]);
    return video;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drags the timeline toward earlier messages until the whole card is below the timeline's top edge, so a screenshot
 * shows all of it rather than its lower strip.
 */
const showCard = (serial: string, card: string) =>
    scrollTimelineUntil(serial, async () => {
        const nodes = await mobileSemantics(serial);
        const frame = checkBounds(nodes, 'conversation-view');
        const bounds = checkBounds(nodes, `agent-chat-message-video-${card}`);
        return Boolean(frame && bounds && bounds.top >= frame.top + 16);
    });

/**
 * Pairs a Codex Chat fixture, sends a message citing a synthetic video, and opens the Chat on the phone with the
 * video's card in view. Returns the card's `testID` suffix; `stop` also removes the video.
 */
async function openChatWithVideo(environment: MobileAgentScenarioEnvironment) {
    const { serial } = environment;
    const video = await createVideo();
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    const stop = async () => {
        await fixture.stop();
        await rm(join(video, '..'), { force: true, recursive: true });
    };
    const chat = fixture.agentChat;
    const sessionId = fixture.allowedSessionId;
    if (!chat || !sessionId) {
        await stop();
        throw new Error('Chat fixture is unavailable');
    }
    try {
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await chat.send({
            text: agentChatTextWithPathReferences(
                'Why does the toast flicker?',
                [{ isDirectory: false, path: video }],
                'Codex',
            ),
        });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (candidate: AgentChatSnapshot) =>
                !candidate.activeTurnId &&
                candidate.items.some(({ type }) => type === 'agentMessage'),
            60_000,
        );
        const message = snapshot.items.find(({ type }) => type === 'userMessage');
        if (!message) throw new Error('The cited message is missing');
        await waitForNoCheck(serial, 'agent-chat-activity');
        const card = `${message.id}-0`;
        await showCard(serial, card);
        return { card, sessionId, stop, video };
    } catch (error) {
        await stop();
        throw error;
    }
}

/**
 * Sends a media key. Every `expo-video` player registers a Media3 session, so pause and play reach it the way a headset
 * button would, without racing the on-screen controls that hide themselves a few seconds after a touch.
 */
const pressMediaKey = (serial: string, key: 'KEYCODE_MEDIA_PAUSE' | 'KEYCODE_MEDIA_PLAY') =>
    adbShell(serial, ['input', 'keyevent', key]);

/**
 * Waits until the player's pixels stop changing. UIAutomator cannot see the controls while a video plays, so every read
 * of them waits for this first; a still frame also proves the pause took effect.
 */
async function waitForStill(serial: string, view: PlayerBounds): Promise<void> {
    try {
        await waitForMobile(
            async () => {
                const first = await mobileRegionFingerprint(serial, view);
                await pause(1_500);
                return first === (await mobileRegionFingerprint(serial, view));
            },
            Boolean,
            20_000,
        );
    } catch {
        throw new Error('The player kept playing');
    }
}

/**
 * The player's bounds, read once as it opens: a semantic read can fail on the paused player, while the bounds never
 * move.
 */
type PlayerBounds = NonNullable<ReturnType<typeof checkBounds>>;

/**
 * Finds the progress bar by its pixels. A paused Media3 player keeps its controls on screen, but UIAutomator cannot
 * dump that screen, so the played (white) part of the bar and its thumb are found in the band just above the time
 * labels. The bar is centered, so its right end mirrors its left margin.
 */
async function findTimeBar(serial: string, view: PlayerBounds) {
    const height = view.bottom - view.top;
    const played = await mobileColorBounds(
        serial,
        {
            bottom: Math.round(view.top + height * 0.952),
            left: view.left,
            right: view.right,
            top: Math.round(view.top + height * 0.9),
        },
        '#ffffff',
    );
    if (!played) throw new Error('The paused player shows no progress bar');
    return {
        left: played.left,
        right: view.right - (played.left - view.left),
        y: Math.round((played.top + played.bottom) / 2),
    };
}

/**
 * Taps the progress bar at `fraction` of its width.
 */
async function seekTo(serial: string, view: PlayerBounds, fraction: number): Promise<void> {
    const bar = await findTimeBar(serial, view);
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.round(bar.left + (bar.right - bar.left) * fraction)),
        String(bar.y),
    ]);
}

/**
 * `MOB-CHAT-VIDEO-01`: a message citing a video shows a card with its poster; the card opens a player that plays,
 * pauses, and seeks, and closing it returns to the same place in the conversation.
 */
export async function executeMobileChatVideoScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('MOB-CHAT-VIDEO-01 records playback and scrubbing');
    const { card, stop } = await openChatWithVideo(environment);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await waitForCheck(serial, `agent-chat-message-video-poster-${card}`, 60_000);
        await capture(environment, 'card', artifacts);
        const before = checkBounds(
            await mobileSemantics(serial),
            `agent-chat-message-video-${card}`,
        );

        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await tapMobileCheckByBounds(serial, `agent-chat-message-video-${card}`);
        await waitForCheck(serial, 'agent-chat-video-player');
        const opened = await mobileSemantics(serial);
        const player = checkBounds(opened, 'agent-chat-video-player');
        const close = checkBounds(opened, 'agent-chat-video-player-close');
        if (!player || !close) throw new Error('The player is not open');
        // The player plays at once and keeps the screen moving, so it is followed by time, not by UIAutomator.
        await pause(3_000);
        await capture(environment, 'playing', artifacts);
        await pressMediaKey(serial, 'KEYCODE_MEDIA_PAUSE');
        await waitForStill(serial, player);
        await capture(environment, 'paused', artifacts);
        await seekTo(serial, player, 0.25);
        await waitForStill(serial, player);
        await capture(environment, 'scrubbed', artifacts);
        await pressMediaKey(serial, 'KEYCODE_MEDIA_PLAY');
        await pause(2_000);
        await recording.stop();
        recording = undefined;

        // Semantic reads fail while the video moves, so the close button is tapped where it was when the player opened.
        // A key event takes the window out of touch mode, and the touch that brings it back never reaches React Native,
        // so a tap on the empty area above the picture (which only toggles the player's controls; the middle of the
        // screen is the play button) goes first.
        await pressMediaKey(serial, 'KEYCODE_MEDIA_PAUSE');
        await waitForStill(serial, player);
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.round((player.left + player.right) / 2)),
            String(Math.round(player.top + (player.bottom - player.top) / 4)),
        ]);
        await pause(1_000);
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.round((close.left + close.right) / 2)),
            String(Math.round((close.top + close.bottom) / 2)),
        ]);
        await waitForNoCheck(serial, 'agent-chat-video-player');
        const after = checkBounds(
            await mobileSemantics(serial),
            `agent-chat-message-video-${card}`,
        );
        if (!before || !after || before.top !== after.top)
            throw new Error('Closing the player moved the conversation');
        await capture(environment, 'closed', artifacts);
        await finish(environment, artifacts, {
            card: 'poster',
            player: 'played-paused-scrubbed',
            returnedToSameSpot: true,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await stop();
    }
}

/**
 * `MOB-CHAT-VIDEO-02`: once the cited video is deleted, reopening the conversation shows its card as unavailable, and
 * the card no longer opens.
 */
export async function executeMobileChatVideoUnavailableScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { card, sessionId, stop, video } = await openChatWithVideo(environment);
    try {
        await waitForCheck(serial, `agent-chat-message-video-poster-${card}`, 60_000);
        await rm(video);
        await tapMobileCheck(serial, 'session-detail-back');
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, `agent-chat-message-video-unavailable-${card}`);
        await showCard(serial, card);
        await capture(environment, 'unavailable', artifacts);
        // The card is disabled, which the tap helpers refuse, so the semantics prove it cannot open the player.
        const nodes = await mobileSemantics(serial);
        const node = nodes.find(({ checkId }) => checkId === `agent-chat-message-video-${card}`);
        if (node?.enabled !== false) throw new Error('The unavailable card can still be opened');
        if (checkBounds(nodes, 'agent-chat-video-player'))
            throw new Error('An unavailable card opened the player');
        await finish(environment, artifacts, {
            card: 'unavailable',
            opens: false,
            status: 'passed',
        });
    } finally {
        await stop();
    }
}
