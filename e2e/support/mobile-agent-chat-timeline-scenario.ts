import type { AgentChatSnapshot } from '@caxri/protocol';
import { windowAgentChatSnapshotForMobile } from '@caxri/protocol';

import type { MobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    chatTimelineFrame,
    checkBounds,
    hasCheck,
    sendFromPhone,
    swipeTimelineTowardEarlier,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import { exerciseChatBackgroundWork } from './mobile-agent-chat-tasks-scenario';
import {
    mobileRegionFingerprint,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

type ChatFixture = NonNullable<MobileAcceptanceFixture['agentChat']>;
type Recording = Awaited<ReturnType<typeof startMobileFramebufferRecording>>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends `text` from the Mac and waits until the fake Agent's echo reply settles. The text avoids every keyword the fake
 * Codex app-server reacts to, so each turn is a plain echo.
 */
async function seedTurn(chat: ChatFixture, text: string): Promise<void> {
    await chat.send({ text });
    await waitForMobile(
        () => chat.read(),
        (snapshot) =>
            !snapshot.activeTurnId &&
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.text.endsWith(text.slice(-40)),
            ),
        60_000,
    );
}

/**
 * The newest phone message whose text is `text`, once Server Core has recorded it.
 */
const userItemId = (snapshot: AgentChatSnapshot, text: string): string | undefined =>
    snapshot.items.findLast((item) => item.type === 'userMessage' && item.text === text)?.id;

/**
 * Pairs and opens the fixture's Chat, waiting for its timeline, or for its empty state when nothing was seeded: an
 * empty Chat shows `agent-chat-status-empty` instead of the timeline.
 */
async function openChat(
    fixture: MobileAcceptanceFixture,
    serial: string,
    readyCheck: 'agent-chat-status-empty' | 'conversation-view' = 'conversation-view',
): Promise<ChatFixture> {
    const chat = fixture.agentChat;
    if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
    await fixture.pair();
    await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
    await waitForCheck(serial, 'agent-chat');
    await waitForCheck(serial, readyCheck);
    return chat;
}

/**
 * `MOB-CHAT-13`: a long reply streams under the message the phone just sent. The sent message is pinned near the top of
 * the timeline while the reply grows below it, and a reader who scrolls up during the stream stays where they scrolled
 * instead of being pulled back to the bottom.
 */
export async function executeMobileChatPinScrollScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Recording | undefined;
    try {
        const seededChat = fixture.agentChat;
        if (!seededChat) throw new Error('Chat fixture is unavailable');
        // Earlier turns fill more than a screen, so an unpinned message would land near the bottom.
        for (let index = 1; index <= 3; index += 1)
            // eslint-disable-next-line no-await-in-loop -- each turn starts after the previous one settles.
            await seedTurn(
                seededChat,
                `Earlier note ${index}. ${'Synthetic context line for the scroll check. '.repeat(8).trim()}`,
            );
        const chat = await openChat(fixture, serial);
        await waitForNoCheck(serial, 'conversation-jump-latest');
        const frame = await chatTimelineFrame(serial);
        const height = frame.bottom - frame.top;
        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;

        /**
         * UIAutomator reads semantics only on an idle screen, and a running turn never idles: the activity line's
         * elapsed time and spinner change every frame. So a short turn first finds where a sent message rests once its
         * turn ends, and the long turn is then followed by pixels in that slot.
         */
        await sendFromPhone(serial, 'pincheck');
        const probed = await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && userItemId(snapshot, 'pincheck') !== undefined,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        const probe = checkBounds(
            await mobileSemantics(serial),
            `conversation-user-${userItemId(probed, 'pincheck')}`,
        );
        if (!probe) throw new Error('The sent message is not laid out');
        const pinnedOffsetRatio = Math.round(((probe.top - frame.top) / height) * 100) / 100;
        if (pinnedOffsetRatio >= 0.3) throw new Error('The sent message did not rise to the top');
        // The slot's rows on the bubble's (right) side; the activity and reply rows start below it.
        const sentRegion = {
            bottom: Math.min(probe.bottom, frame.bottom),
            left: frame.left + Math.floor((frame.right - frame.left) / 2),
            right: frame.right,
            top: Math.max(probe.top, frame.top),
        };
        const probeFingerprint = await mobileRegionFingerprint(serial, sentRegion);

        await sendFromPhone(serial, 'longstream');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                Boolean(snapshot.activeTurnId) && userItemId(snapshot, 'longstream') !== undefined,
        );
        // The new message takes the slot once the scroll to it lands: the slot changes, then holds still.
        let previous = probeFingerprint;
        await waitForMobile(
            async () => {
                const current = await mobileRegionFingerprint(serial, sentRegion);
                const isSettled = current !== probeFingerprint && current === previous;
                previous = current;
                return isSettled;
            },
            Boolean,
            10_000,
        );
        await capture(environment, 'pinned', artifacts);

        // While the reply streams, the sent message keeps its place: its pixels do not move between two moments.
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('Paragraph 02'),
            30_000,
        );
        const earlyPin = await mobileRegionFingerprint(serial, sentRegion);
        await capture(environment, 'pinned-streaming', artifacts);
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('Paragraph 04'),
            30_000,
        );
        if ((await mobileRegionFingerprint(serial, sentRegion)) !== earlyPin)
            throw new Error('The sent message moved while the reply streamed');

        // Scrolling up mid-stream: the top of the timeline holds still while the reply keeps growing below.
        await swipeTimelineTowardEarlier(serial, frame);
        await pause(1_500);
        const readingRegion = {
            bottom: frame.top + Math.floor(height * 0.4),
            left: frame.left,
            right: frame.right,
            top: frame.top,
        };
        const beforeLength = agentText(await chat.read()).length;
        const beforeFingerprint = await mobileRegionFingerprint(serial, readingRegion);
        await capture(environment, 'scrolled-while-streaming', artifacts);
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).length > beforeLength + 400 || !snapshot.activeTurnId,
            30_000,
        );
        const isStreaming = Boolean((await chat.read()).activeTurnId);
        if ((await mobileRegionFingerprint(serial, readingRegion)) !== beforeFingerprint)
            throw new Error('Scrolling up during the stream did not hold the reading position');
        if (!isStreaming)
            throw new Error('The reply ended before the scroll check could observe it');
        await capture(environment, 'still-scrolled', artifacts);

        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('Paragraph 40') && !snapshot.activeTurnId,
            90_000,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        // The stream ended without pulling the reader back: Jump to latest is still offered.
        await waitForCheck(serial, 'conversation-jump-latest');
        await capture(environment, 'after-stream', artifacts);
        await tapMobileCheckByBounds(serial, 'conversation-jump-latest');
        await waitForNoCheck(serial, 'conversation-jump-latest');
        await capture(environment, 'latest', artifacts);
        await recording?.stop();
        recording = undefined;

        await finish(environment, artifacts, {
            pinnedOffsetRatio,
            pinnedWhileStreaming: 'unchanged',
            scrolledUpWhileStreaming: 'held',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-15`: the activity line's shimmer sweep, recorded with animations on. The runner turns the batch's reduced
 * motion off for this case alone, so the scenario reads no semantics while the shimmer runs: UIAutomator never finds an
 * idle window on a screen that keeps moving. Framebuffer frames and the recording carry the evidence.
 */
export async function executeMobileChatShimmerScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Recording | undefined;
    try {
        const chat = await openChat(fixture, serial, 'agent-chat-status-empty');
        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;
        await sendFromPhone(serial, 'slow');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                Boolean(snapshot.activeTurnId) &&
                snapshot.items.some((item) => item.type === 'reasoning'),
        );
        // Frames a fraction of a second apart catch the sweep at different positions.
        for (let frame = 1; frame <= 3; frame += 1) {
            // eslint-disable-next-line no-await-in-loop -- each frame is a later moment of the same sweep.
            await capture(environment, `shimmer-${frame}`, artifacts);
            // eslint-disable-next-line no-await-in-loop -- spaced frames show the sweep moving.
            await pause(350);
        }
        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId,
            60_000,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'settled', artifacts);
        await recording?.stop();
        recording = undefined;

        await finish(environment, artifacts, {
            motion: 'live',
            shimmer: 'recorded',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

/**
 * About 3,600 characters: under the phone's 4,000-character field clip, and with the echo reply about 7 KiB a turn.
 */
/**
 * Swipes between two semantic reads while `MOB-CHAT-16` scrolls toward the start: the phone's window holds about six
 * seeded turns of several screens each.
 */
const SWIPES_PER_READ = 4;

const historyEntry = (index: number): string =>
    `${`Synthetic history entry number ${String(index).padStart(2, '0')} keeps the window full. `.repeat(60).trim()}`;

/**
 * `MOB-CHAT-16`: a Chat longer than the phone's 48 KiB window offers its earlier messages, and loading them shows a
 * message the first window left out. Then background work: the pill above the composer, its sheet, and a task's detail
 * with the tail of its output, which Stop ends.
 */
export async function executeMobileChatHistoryTasksScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const seededChat = fixture.agentChat;
        if (!seededChat) throw new Error('Chat fixture is unavailable');
        for (let index = 1; index <= 10; index += 1)
            // eslint-disable-next-line no-await-in-loop -- each turn starts after the previous one settles.
            await seedTurn(seededChat, historyEntry(index));
        const full = await seededChat.read();
        const windowed = windowAgentChatSnapshotForMobile(full);
        if (!windowed.truncated) throw new Error('The seeded Chat fits the phone window');
        const shown = new Set(windowed.items.map(({ id }) => id));
        const leftOut = full.items.findLast(
            (item) => item.type === 'userMessage' && !shown.has(item.id),
        );
        if (!leftOut) throw new Error('No seeded message falls outside the phone window');
        const leftOutId = `conversation-user-${leftOut.id}`;

        await openChat(fixture, serial);
        if (hasCheck(await mobileSemantics(serial), leftOutId))
            throw new Error('The first window already shows the left-out message');
        await capture(environment, 'history-latest', artifacts);

        // Scroll toward the start until Load earlier shows (tap it) or the list loads the page on reaching its start.
        const frame = await chatTimelineFrame(serial);
        let isLoadEarlierSeen = false;
        let isLoadEarlierTapped = false;
        let isRevealed = false;
        for (let attempt = 0; !isRevealed && attempt < 30; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each read decides the next gesture.
            const nodes = await mobileSemantics(serial);
            if (hasCheck(nodes, leftOutId)) {
                isRevealed = true;
            } else if (!isLoadEarlierTapped && hasCheck(nodes, 'conversation-load-earlier')) {
                isLoadEarlierSeen = true;
                // eslint-disable-next-line no-await-in-loop -- the frame shows the control before it is used.
                await capture(environment, 'load-earlier', artifacts);
                // eslint-disable-next-line no-await-in-loop -- the tap follows the capture.
                await tapMobileCheckByBounds(serial, 'conversation-load-earlier');
                isLoadEarlierTapped = true;
            } else {
                // Each seeded message spans screens, so several swipes run between the slow semantic reads.
                for (let swipe = 0; swipe < SWIPES_PER_READ; swipe += 1)
                    // eslint-disable-next-line no-await-in-loop -- each gesture moves the same list further.
                    await swipeTimelineTowardEarlier(serial, frame);
            }
        }
        if (!isRevealed) throw new Error('The earlier message never appeared on the phone');
        await capture(environment, 'earlier-revealed', artifacts);

        // Background work.
        if (hasCheck(await mobileSemantics(serial), 'conversation-jump-latest')) {
            await tapMobileCheckByBounds(serial, 'conversation-jump-latest');
            await waitForNoCheck(serial, 'conversation-jump-latest');
        }
        await exerciseChatBackgroundWork(environment, seededChat, artifacts);

        await finish(environment, artifacts, {
            history: 'earlier-revealed',
            loadEarlier: isLoadEarlierTapped ? 'tapped' : 'loaded-on-reaching-start',
            loadEarlierSeen: isLoadEarlierSeen,
            taskDetail: 'output-tail-shown',
            taskStop: 'stopped',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
