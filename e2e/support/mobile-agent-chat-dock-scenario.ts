import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    checkBounds,
    hasCheck,
    waitForCheck,
    withVisibleKeyboard,
} from './mobile-agent-chat-helpers';
import {
    copyMobileFramebufferRecording,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import type { MobileAndroidCaseEnvironment } from './mobile-android-case-registry';
import { requireRemoteVideoPath } from './mobile-android-case-registry';
import { inBetweenFrames, readRecordingBand } from './mobile-motion-analysis';

const runningShells = (snapshot: AgentChatSnapshot): number =>
    (snapshot.tasks ?? []).filter((task) => task.kind === 'shell' && task.status === 'running')
        .length;

const pause = (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Lets the keyboard's slide and any dock transition finish inside the recording before the next action.
 */
const SETTLE_MS = 1200;

type ChatFixture = Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;

/**
 * Opens a paired Claude Code Chat pursuing a goal with two background shells running, the dock the goal bar and the `2
 * Background work` row fill, and returns the composer's frame with the keyboard down.
 *
 * The fake's goal query streams for minutes (`fake-claude-goal.ts`), so the setup interrupts it once the goal is set;
 * like real Claude Code, the interrupt keeps the goal and the background shells.
 */
async function openGoalDock(serial: string, fixture: ChatFixture) {
    const chat = fixture.agentChat;
    if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
    await fixture.pair();
    for (let shell = 1; shell <= 2; shell += 1) {
        // eslint-disable-next-line no-await-in-loop -- each shell starts in its own turn
        await chat.send({ text: 'background' });
        // eslint-disable-next-line no-await-in-loop -- the next turn waits for this one to end
        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && runningShells(snapshot) === shell,
        );
    }
    await chat.runCommand({
        name: AGENT_CHAT_GOAL_COMMAND,
        arguments: 'every emulator check passes',
    });
    await waitForMobile(
        () => chat.read(),
        (snapshot) => snapshot.goal?.status === 'active' && snapshot.activeTurnId !== undefined,
    );
    // An interrupted turn keeps the goal active and the shells running, and leaves a still screen to capture.
    await chat.interrupt();
    await waitForMobile(
        () => chat.read(),
        (snapshot) =>
            snapshot.goal?.status === 'active' &&
            !snapshot.activeTurnId &&
            runningShells(snapshot) === 2,
    );

    await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
    await waitForCheck(serial, 'agent-chat-goal');
    const composerDown = checkBounds(await mobileSemantics(serial), 'agent-chat-composer-input');
    if (!composerDown) throw new Error('The composer is not laid out');
    return { composerDown };
}

/**
 * Waits until the app's own keyboard layout lifts the composer, which proves the app saw the keyboard.
 */
const waitForLiftedComposer = (serial: string, composerDown: { top: number }) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (current) => {
            const composer = checkBounds(current, 'agent-chat-composer-input');
            return composer !== undefined && composer.top < composerDown.top - 300;
        },
    );

/**
 * `MOB-CHAT-DOCK-FOLD-01`: with the keyboard down the goal bar and the `2 Background work` row stack above the
 * composer, and with the keyboard up they stay as they are: background work does not count toward folding, so no
 * summary row replaces the goal bar.
 */
export async function executeMobileChatDockFoldScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        chatProvider: 'claude',
        serial,
    });
    try {
        const { composerDown } = await openGoalDock(serial, fixture);
        await capture(environment, 'keyboard-down', artifacts);

        // The fixture IME draws no keyboard and reports none to the app, so the emulator's own keyboard is the one up.
        const dock = { isUnfolded: false };
        await withVisibleKeyboard(serial, async () => {
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
            // Without a lifted composer the summary's absence below would pass before the dock had a chance to fold.
            const nodes = await waitForLiftedComposer(serial, composerDown);
            dock.isUnfolded =
                hasCheck(nodes, 'agent-chat-goal') &&
                hasCheck(nodes, 'agent-chat-tasks') &&
                !hasCheck(nodes, 'agent-chat-dock-summary');
            await capture(environment, 'keyboard-up', artifacts);
        });
        if (!dock.isUnfolded) {
            // Keep the captures citable in the failed round before failing it.
            await finish(environment, artifacts, { folded: 'summary', status: 'failed' });
            throw new Error(
                'The dock folded a goal with only background work while the keyboard was up',
            );
        }

        await finish(environment, artifacts, { folded: 'none', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

/**
 * Most in-between frames a keyboard transition may draw in the lifted dock's band. The composer and the unanimated rows
 * jump there in one layout pass, so a dock that moves with them draws at most a frame or two while the pass lands; a
 * goal bar on its own 180ms transition draws one per frame for the whole slide.
 */
const MAX_DOCK_IN_BETWEEN_FRAMES = 3;

/**
 * `MOB-CHAT-DOCK-KEYBOARD-01`: the same goal dock, recorded with live motion while the keyboard shows and hides. The
 * goal bar must move with the `2 Background work` row and the composer, not trail them by its own height transition and
 * slide over the composer or the keyboard.
 *
 * UIAutomator cannot read a screen while it moves, so the recording is analysed instead, in the band the lifted dock
 * occupies from the goal bar's top to the composer's bottom. The keyboard stays below that band, so on the way up the
 * band changes from timeline to dock and on the way down back to timeline; each change must land at once.
 */
export async function executeMobileChatDockKeyboardScenario(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        chatProvider: 'claude',
        serial,
    });
    const remoteVideoPath = requireRemoteVideoPath(environment);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const { composerDown } = await openGoalDock(serial, fixture);
        const lifted = { band: { bottom: 0, top: 0 }, splitMs: 0 };
        await withVisibleKeyboard(serial, async () => {
            recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
            const startedAt = Date.now();
            await pause(SETTLE_MS);
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
            const nodes = await waitForLiftedComposer(serial, composerDown);
            const goal = checkBounds(nodes, 'agent-chat-goal');
            const composer = checkBounds(nodes, 'agent-chat-composer-input');
            if (!goal || !composer) throw new Error('The lifted dock is not laid out');
            lifted.band = { bottom: composer.bottom, top: goal.top };
            await pause(SETTLE_MS);
            // Halfway through the still keyboard-up stretch, between the show and the hide.
            lifted.splitMs = Date.now() - startedAt - SETTLE_MS / 2;
            await capture(environment, 'keyboard-up', artifacts);
        });
        // `withVisibleKeyboard` hid the keyboard on its way out; the recording keeps the drop.
        await pause(SETTLE_MS);
        await capture(environment, 'keyboard-down', artifacts);
        await recording?.stop();
        recording = undefined;

        const analysis = await mkdtemp(join(tmpdir(), 'caxri-dock-keyboard-'));
        try {
            const video = join(analysis, 'dock-keyboard.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            const { frames } = await readRecordingBand(video, lifted.band);
            const show = inBetweenFrames(frames.filter(({ time }) => time < lifted.splitMs));
            const hide = inBetweenFrames(frames.filter(({ time }) => time >= lifted.splitMs));
            const isSteady =
                show.count <= MAX_DOCK_IN_BETWEEN_FRAMES &&
                hide.count <= MAX_DOCK_IN_BETWEEN_FRAMES;
            await finish(environment, artifacts, {
                hide,
                maxInBetweenFrames: MAX_DOCK_IN_BETWEEN_FRAMES,
                show,
                status: isSteady ? 'passed' : 'failed',
            });
            if (!isSteady)
                throw new Error(
                    `The dock drew ${show.count} in-between frames as the keyboard showed and ${hide.count} as it hid`,
                );
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
