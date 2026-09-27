import {
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android.ts';
import type { ScenarioEnvironment } from './mobile-conversation-scenarios.ts';
import {
    capture,
    conversationFixture,
    finish,
    openConversation,
    requireRemoteVideoPath,
} from './mobile-conversation-scenarios.ts';
import {
    conversationAgentRecords,
    conversationBaselineRecords,
} from './mobile-conversation-transcript.ts';

/**
 * Records one phone-layout open of a long Conversation and the return to Session home, so the framebuffer shows whether
 * the list scrolls into place or the home list jumps (#1329).
 */
export async function executeMobileConversationTransitionScenario(
    environment: ScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await conversationFixture(environment.serial);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.appendTranscript(conversationBaselineRecords());
        await fixture.appendTranscript(conversationAgentRecords(10, 60));
        await fixture.pair();
        const latest = (await fixture.readTimeline()).items.at(-1);
        if (!latest) throw new Error('Synthetic Conversation is empty');
        recording = await startMobileFramebufferRecording(
            environment.serial,
            requireRemoteVideoPath(),
        );
        await openConversation(environment.serial, fixture.allowedSessionId);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === `conversation-agent-${latest.id}`),
        );
        // Let late layout corrections land inside the recording before leaving.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await capture(environment, 'opened', artifacts);
        await tapMobileCheck(environment.serial, 'session-detail-back');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(
                    ({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`,
                ) && nodes.every(({ checkId }) => checkId !== 'session-detail'),
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await capture(environment, 'returned', artifacts);
        await recording.stop();
        recording = undefined;
        await finish(environment, artifacts, {
            open: 'latest-entry-visible',
            return: 'session-home-visible',
            recordingBoundary: 'before-open-through-settled-home',
            status: 'passed',
            syntheticHistoryCount: 60,
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
