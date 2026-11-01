import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { replyTurnId, showBar } from './mobile-agent-chat-reply-actions-scenario';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    observeMobileNode,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const PROMPT = 'Collect the pages on this topic';

/**
 * Ten pages, a web call's most, so the Sources list scrolls and the scroll position it returns to is observable.
 */
const LINKS = Array.from({ length: 10 }, (_, index) => ({
    title: `Example source page ${index + 1}`,
    url: `https://example.com/source-${index + 1}`,
}));

const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                {
                    kind: 'tool',
                    name: 'WebSearch',
                    input: { query: 'example sources' },
                    output: `Web search results for query: "example sources"\n\nLinks: ${JSON.stringify(LINKS)}`,
                },
                { kind: 'text', text: 'Target pages collected.' },
            ],
        },
    ],
};

/**
 * Where a Sources row sits on screen, to prove the list comes back at the scroll position the reader left it.
 */
async function rowTop(serial: string, index: number): Promise<number | undefined> {
    const node = (await mobileSemantics(serial)).find(
        ({ checkId }) => checkId === `agent-chat-source-${index}`,
    );
    return node ? androidBounds(node.bounds)?.top : undefined;
}

/**
 * Opens one Sources row in the in-app browser and returns, once through the browser's close button and once through
 * Android Back, proving the list comes back each time.
 */
async function readSourceAndReturn(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    index: number,
    via: 'back' | 'close',
): Promise<{ isOpenedRowFocused: boolean }> {
    const { serial } = environment;
    const topBefore = await rowTop(serial, index);
    await tapMobileCheckByBounds(serial, `agent-chat-source-${index}`);
    await waitForCheck(serial, 'in-app-browser', 30_000);
    await waitForNoCheck(serial, 'agent-chat-sources-sheet');
    await capture(environment, `page-${index}`, artifacts);
    if (via === 'close') await tapMobileCheckByBounds(serial, 'in-app-browser-close');
    else await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
    await waitForNoCheck(serial, 'in-app-browser');
    await waitForCheck(serial, 'agent-chat-sources-sheet');
    await waitForCheck(serial, `agent-chat-source-${index}`);
    // The sheet slides back in; read the row once it has settled.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const topAfter = await rowTop(serial, index);
    if (topBefore === undefined || topAfter === undefined || Math.abs(topAfter - topBefore) > 4)
        throw new Error(`Source ${index} moved from ${topBefore} to ${topAfter} after the return`);
    await capture(environment, `list-back-${index}`, artifacts);
    const { focused } = await observeMobileNode(serial, `agent-chat-source-${index}`);
    return { isOpenedRowFocused: focused };
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
        await waitForCheck(serial, 'agent-chat-source-0');
        await capture(environment, 'sources-open', artifacts);

        const first = await readSourceAndReturn(environment, artifacts, 0, 'close');
        // Scroll the list so the second page is read from further down, where a fresh list would not open.
        const sheet = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === 'agent-chat-sources-sheet',
        );
        const frame = sheet && androidBounds(sheet.bounds);
        if (!frame) throw new Error('The Sources list has no bounds');
        const x = String(Math.round((frame.left + frame.right) / 2));
        await adbShell(serial, [
            'input',
            'swipe',
            x,
            String(frame.bottom - 80),
            x,
            String(frame.top + 300),
            '600',
        ]);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const scrolled = LINKS.length - 1;
        await waitForCheck(serial, `agent-chat-source-${scrolled}`);
        await capture(environment, 'sources-scrolled', artifacts);
        const last = await readSourceAndReturn(environment, artifacts, scrolled, 'back');

        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-sources-sheet');
        await finish(environment, artifacts, {
            listAfterClose: 'restored',
            listAfterSystemBack: 'restored-at-scroll-position',
            openedRowInputFocused: [first.isOpenedRowFocused, last.isOpenedRowFocused],
            pagesRead: 2,
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
