import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatTextWithPathReferences } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    checkBounds,
    scrollTimelineTo,
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
 * The synthetic video every case seeds: 20 seconds of FFmpeg's `testsrc`, whose frame counter shows where playback is,
 * so a screenshot after a seek proves the scrub landed.
 */
const VIDEO = 'media/demo.mp4';
const VIDEO_SECONDS = 20;

/**
 * The player's progress bar. `expo-video` draws Media3's `PlayerView` controls, whose ids merge into the app package.
 */
const TIME_BAR = 'com.caxri.mobile:id/exo_progress';

const seedVideo = async (root: string) => {
    await mkdir(join(root, 'media'), { recursive: true });
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
        join(root, VIDEO),
    ]);
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pairs a Codex Chat fixture whose Project holds {@link VIDEO}, sends a message citing it, and opens the Chat on the
 * phone with the video's card in view. Returns the card's `testID` suffix.
 */
async function openChatWithVideo(environment: MobileAgentScenarioEnvironment) {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        seedProject: seedVideo,
        serial,
    });
    const chat = fixture.agentChat;
    const sessionId = fixture.allowedSessionId;
    if (!chat || !sessionId) {
        await fixture.stop();
        throw new Error('Chat fixture is unavailable');
    }
    try {
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        const video = join(fixture.testDirectory, 'allowed-project', VIDEO);
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
        await scrollTimelineTo(serial, `agent-chat-message-video-${card}`);
        return { card, fixture, sessionId, video };
    } catch (error) {
        await fixture.stop();
        throw error;
    }
}

/**
 * Taps the timeline's progress bar at `fraction` of its width. The bar shows only with the controls, and only a paused
 * player lets UIAutomator read the screen.
 */
async function seekTo(serial: string, fraction: number): Promise<void> {
    const bar = await waitForMobile(
        () => mobileNativeControlBounds(serial, { resourceId: TIME_BAR }),
        (bounds) => bounds !== null,
        15_000,
    );
    if (!bar) throw new Error('The player shows no progress bar');
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.round(bar.left + (bar.right - bar.left) * fraction)),
        String(Math.round((bar.top + bar.bottom) / 2)),
    ]);
}

/**
 * Taps the middle of the player: the first tap shows the controls, and the next one presses their play/pause button,
 * which sits in the middle.
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
 * `MOB-CHAT-VIDEO-01`: a message citing a video shows a card with its poster; the card opens a player that plays,
 * pauses, and seeks, and closing it returns to the same place in the conversation.
 */
export async function executeMobileChatVideoScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('MOB-CHAT-VIDEO-01 records playback and scrubbing');
    const { card, fixture } = await openChatWithVideo(environment);
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
        await tapPlayer(serial);
        await pause(500);
        await tapPlayer(serial);
        await waitForCheck(serial, 'agent-chat-video-player-view');
        await capture(environment, 'paused', artifacts);
        await seekTo(serial, 0.75);
        await pause(1_000);
        await capture(environment, 'scrubbed', artifacts);
        await tapPlayer(serial);
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
        await fixture.stop();
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
    const { card, fixture, sessionId, video } = await openChatWithVideo(environment);
    try {
        await waitForCheck(serial, `agent-chat-message-video-poster-${card}`, 60_000);
        await rm(video);
        await tapMobileCheck(serial, 'session-detail-back');
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await scrollTimelineTo(serial, `agent-chat-message-video-${card}`);
        await waitForCheck(serial, `agent-chat-message-video-unavailable-${card}`);
        await capture(environment, 'unavailable', artifacts);
        await tapMobileCheckByBounds(serial, `agent-chat-message-video-${card}`);
        await pause(1_000);
        const nodes = await mobileSemantics(serial);
        if (checkBounds(nodes, 'agent-chat-video-player'))
            throw new Error('An unavailable card opened the player');
        await finish(environment, artifacts, {
            card: 'unavailable',
            opens: false,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
