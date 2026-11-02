import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileDisplayState,
    mobileNativeControlBounds,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import { startMobileBrowserPage } from './mobile-browser-page-fixture';

/**
 * The user bubble's line height in dp (`conversationStyles.userText`, `mobileType.body`).
 */
const USER_LINE_HEIGHT_DP = 22;

/**
 * Words the user writes right after the URL, as a pasted pull request link with a note reads.
 */
const USER_LINK_SUFFIX = ' 合了';

/**
 * `MOB-CHAT-USER-LINK-01`: the user's own message carries a pasted URL followed by a note, as Desktop's Chat links it.
 * A tap on the URL's first characters in the user bubble opens the page in the in-app browser, and the page's fetch
 * count proves the tap reached that exact URL. Before the fix the bubble rendered the URL as plain text and the tap did
 * nothing.
 */
export async function executeMobileChatUserLinkScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const page = await startMobileBrowserPage();
    let fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>> | undefined;
    try {
        fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        const text = `${page.url}${USER_LINK_SUFFIX}`;
        await chat.send({ text });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        await waitForNoCheck(serial, 'agent-chat-activity');

        const bubble = await waitForMobile(
            () => mobileNativeControlBounds(serial, { className: 'android.widget.TextView', text }),
            (candidate) => candidate !== null,
            15_000,
        );
        if (!bubble) throw new Error('The user bubble is not on screen');
        await capture(environment, 'user-link-bubble', artifacts);

        const display = await mobileDisplayState(serial);
        const scale =
            ((display.density.override ?? display.density.physical) / 160) * display.fontScale;
        const lineHeight = USER_LINE_HEIGHT_DP * scale;
        await adbShell(serial, [
            'input',
            'tap',
            String(bubble.left + Math.round(lineHeight)),
            String(Math.round(bubble.top + lineHeight / 2)),
        ]);
        await waitForCheck(serial, 'in-app-browser');
        await waitForMobile(
            () => page.hits(),
            (hits) => hits >= 1,
        );
        await capture(environment, 'browser', artifacts);
        await tapMobileCheckByBounds(serial, 'in-app-browser-close');
        await waitForNoCheck(serial, 'in-app-browser');
        await waitForCheck(serial, 'agent-chat');

        await finish(environment, artifacts, {
            browser: 'opened-from-user-message-url',
            pageFetches: page.hits(),
            status: 'passed',
        });
    } finally {
        await fixture?.stop();
        await page.close();
    }
}
