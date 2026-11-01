import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    LINKS,
    PROMPT,
    replyTurnId,
    script,
    showBar,
} from './mobile-agent-chat-reply-actions-scenario';
import {
    adbShell,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * Opens one Sources row in the in-app browser and returns, once through the browser's close button and once through
 * Android Back, proving the list comes back each time.
 */
async function readSourceAndReturn(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    index: number,
    via: 'back' | 'close',
): Promise<void> {
    const { serial } = environment;
    await tapMobileCheckByBounds(serial, `agent-chat-source-${index}`);
    await waitForCheck(serial, 'in-app-browser', 30_000);
    await waitForNoCheck(serial, 'agent-chat-sources-sheet');
    await capture(environment, `page-${index}`, artifacts);
    if (via === 'close') await tapMobileCheckByBounds(serial, 'in-app-browser-close');
    else await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
    await waitForNoCheck(serial, 'in-app-browser');
    await waitForCheck(serial, 'agent-chat-sources-sheet');
    await waitForCheck(serial, `agent-chat-source-${LINKS.length - 1}`);
    await capture(environment, `list-back-${index}`, artifacts);
}

/**
 * `MOB-CHAT-SOURCES-RETURN-01` (#3423): after reading a page opened from a reply's Sources, the reader returns to the
 * same Sources list instead of the bare Chat, so they can open the next page without finding the list again.
 */
export async function executeMobileChatSourcesReturnScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('Scenario-owned Android recording path is unavailable');
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        serial,
    });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: PROMPT });
        const answered = await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && replyTurnId(snapshot, 'Target') !== undefined,
            60_000,
        );
        const searched = replyTurnId(answered, 'Target');
        if (!searched) throw new Error('The scripted turn did not finish');

        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, `agent-chat-reply-sources-${searched}`, 60_000);
        await showBar(serial, searched);
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await tapMobileCheckByBounds(serial, `agent-chat-reply-sources-${searched}`, {
            viewport: 'conversation-view',
        });
        await waitForCheck(serial, 'agent-chat-sources-sheet');
        await waitForCheck(serial, `agent-chat-source-${LINKS.length - 1}`);
        await capture(environment, 'sources-open', artifacts);

        await readSourceAndReturn(environment, artifacts, 0, 'close');
        await readSourceAndReturn(environment, artifacts, 1, 'back');

        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-sources-sheet');
        await finish(environment, artifacts, {
            listAfterClose: 'restored',
            listAfterSystemBack: 'restored',
            pagesRead: 2,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
