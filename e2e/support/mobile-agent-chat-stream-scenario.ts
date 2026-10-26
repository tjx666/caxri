import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import { startMobileFramebufferRecording, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * The fake Codex `burststream` reply's closing words, which only its last delta carries.
 */
const BURST_STREAM_END = 'after the Agent has stopped.';

/**
 * `MOB-CHAT-30`: a reply whose text arrives in 23 large deltas 400ms apart, the way a phone on a cellular or VPN link
 * receives a stream in clumps, types out steadily instead of jumping in blocks. Smoothness is a judgement over time, so
 * the recording is the evidence; the stream runs with animations on, and no semantics are read while it runs because
 * UIAutomator finds no idle window on a moving screen. The pacer's numbers are pinned by its unit test.
 */
export async function executeMobileChatBurstStreamScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;
        await sendFromPhone(serial, 'burststream');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => Boolean(snapshot.activeTurnId) && agentText(snapshot).length > 0,
        );
        // No frame is captured mid-stream: a framebuffer read can stall the recording and fake the very pause under test.
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes(BURST_STREAM_END) && !snapshot.activeTurnId,
            30_000,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'settled', artifacts);
        await recording?.stop();
        recording = undefined;

        await finish(environment, artifacts, {
            arrival: 'twenty-three-deltas-400ms-apart',
            motion: 'live',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
