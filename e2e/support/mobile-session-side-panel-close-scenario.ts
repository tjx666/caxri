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
import { analyseDrawerClose } from './mobile-drawer-close-analysis';
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
