import { FAKE_CODEX_BARE_LINK_SUFFIX } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-replies.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
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
 * The reply body's line height in dp (`ConversationMarkdown`'s `body.lineHeight`).
 */
const REPLY_LINE_HEIGHT_DP = 23;

/**
 * `MOB-CHAT-BARE-LINK-01`: an Agent reply that writes a URL as plain text, followed directly by a CJK full stop, as
 * Desktop's Chat links it. A tap on the URL's first characters opens the page in the in-app browser, and the page's
 * fetch count proves the link stopped before the full stop: a link that swallowed it asks for another path, which the
 * page answers with a 404. Before the fix the URL rendered as plain text and the tap did nothing.
 */
export async function executeMobileChatBareLinkScenario(
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
        await chat.send({ text: `weblink bare ${page.url}` });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes(page.url) && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');

        const paragraph = await waitForMobile(
            () =>
                mobileNativeControlBounds(serial, {
                    className: 'android.widget.TextView',
                    text: `${page.url}${FAKE_CODEX_BARE_LINK_SUFFIX}`,
                }),
            (candidate) => candidate !== null,
            15_000,
        );
        if (!paragraph) throw new Error('The reply paragraph is not on screen');
        await capture(environment, 'bare-link-reply', artifacts);

        const display = await mobileDisplayState(serial);
        const scale =
            ((display.density.override ?? display.density.physical) / 160) * display.fontScale;
        const lineHeight = REPLY_LINE_HEIGHT_DP * scale;
        await adbShell(serial, [
            'input',
            'tap',
            String(paragraph.left + Math.round(lineHeight)),
            String(Math.round(paragraph.top + lineHeight / 2)),
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
            browser: 'opened-from-bare-url',
            link: 'stops-before-cjk-full-stop',
            pageFetches: page.hits(),
            status: 'passed',
        });
    } finally {
        await fixture?.stop();
        await page.close();
    }
}
