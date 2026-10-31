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
    mobileNativeControlBounds,
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
 * not show it. Server Core serves any path the message cites, inside a Project or not.
 */
const VIDEO_NAME = 'demo.mp4';
const VIDEO_SECONDS = 60;

/**
 * The player's progress bar. `expo-video` draws Media3's `PlayerView` controls, whose ids merge into the app package.
 */
const TIME_BAR = 'com.caxri.mobile:id/exo_progress';

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
 * Taps the middle of the player. While the controls are hidden a tap only shows them; once shown, the same spot is
 * their play/pause button.
 */
async function tapPlayer(serial: string): Promise<void> {
    const view = checkBounds(await mobileSemantics(serial), 'agent-chat-video-player');
    if (!view) throw new Error('The player is not open');
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.round((view.left + view.right) / 2)),
        String(Math.round((view.top + view.bottom) / 2)),
    ]);
}

/**
 * Sends a media key. Every `expo-video` player registers a Media3 session, so pause and play reach it the way a headset
 * button would, without racing the on-screen controls that hide themselves a few seconds after a touch.
 */
const pressMediaKey = (serial: string, key: 'KEYCODE_MEDIA_PAUSE' | 'KEYCODE_MEDIA_PLAY') =>
    adbShell(serial, ['input', 'keyevent', key]);

const timeBar = (serial: string) => mobileNativeControlBounds(serial, { resourceId: TIME_BAR });

/**
 * Returns the progress bar, showing the controls first when Media3 has hidden them, which it does a few seconds after
 * the last touch even while paused.
 */
async function showControls(serial: string) {
    const shown = await timeBar(serial);
    if (shown) return shown;
    const before = await playerControls(serial);
    await tapPlayer(serial);
    try {
        const bar = await waitForMobile(
            () => timeBar(serial),
            (bounds) => bounds !== null,
            15_000,
        );
        if (bar) return bar;
    } catch {
        // Reported below with what the screen held.
    }
    throw new Error(
        `The player shows no progress bar; controls before the tap: ${before}; after: ${await playerControls(serial)}`,
    );
}

/**
 * Lists the Media3 control ids UIAutomator can see, so a missing progress bar says what the screen held instead.
 */
async function playerControls(serial: string): Promise<string> {
    const dumpPath = '/data/local/tmp/caxri-acceptance-video-controls.xml';
    try {
        await adbShell(serial, ['uiautomator', 'dump', dumpPath]);
        const source = await adbShell(serial, ['cat', dumpPath]);
        const ids = new Set(
            source
                .matchAll(/resource-id="com\.caxri\.mobile:id\/(exo_[^"]+)"/gu)
                .map(([, id]) => id),
        );
        return [...ids].join(', ') || 'none';
    } catch (error) {
        return `dump failed (${error instanceof Error ? error.message : String(error)})`;
    } finally {
        await adbShell(serial, ['rm', '-f', dumpPath]);
    }
}

/**
 * Taps the progress bar at `fraction` of its width. UIAutomator reads the screen only while the player is paused.
 */
async function seekTo(serial: string, fraction: number): Promise<void> {
    const bar = await showControls(serial);
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.round(bar.left + (bar.right - bar.left) * fraction)),
        String(Math.round((bar.top + bar.bottom) / 2)),
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
        // The player plays at once and keeps the screen moving, so it is followed by time, not by UIAutomator.
        await pause(3_000);
        await capture(environment, 'playing', artifacts);
        await pressMediaKey(serial, 'KEYCODE_MEDIA_PAUSE');
        await waitForCheck(serial, 'agent-chat-video-player-view');
        await showControls(serial);
        await capture(environment, 'paused', artifacts);
        await seekTo(serial, 0.25);
        await pause(1_000);
        await capture(environment, 'scrubbed', artifacts);
        await pressMediaKey(serial, 'KEYCODE_MEDIA_PLAY');
        await pause(2_000);
        await recording.stop();
        recording = undefined;

        await tapMobileCheckByBounds(serial, 'agent-chat-video-player-close');
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
