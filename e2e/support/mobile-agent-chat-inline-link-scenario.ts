import { FAKE_CODEX_INLINE_LINK_PREFIX } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-replies.ts';
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
 * `MOB-CHAT-LINK-WRAP-01`: an Agent reply whose long URL follows a label on the same line, the shape of an Acceptance
 * handoff. The label and the URL must lay out as one wrapping paragraph inside the screen: Android then reports them as
 * one text view whose text is the whole line. Before the fix the URL was a separate box that kept to one line and ran
 * past the screen edge. A tap on the paragraph's last line, which only the wrapped URL reaches, opens the page in the
 * in-app browser.
 */
export async function executeMobileChatInlineLinkScenario(
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
        // A synthetic id as long as an Acceptance id, so the URL is wider than the phone.
        const url = `${page.url}?report=00000000-0000-4000-8000-000000000000`;
        await chat.send({ text: `weblink inline ${url}` });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes(url) && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');

        const paragraph = await waitForMobile(
            () =>
                mobileNativeControlBounds(serial, {
                    className: 'android.widget.TextView',
                    text: `${FAKE_CODEX_INLINE_LINK_PREFIX}${url}`,
                }),
            (candidate) => candidate !== null,
            15_000,
        );
        if (!paragraph) throw new Error('The label and its link are not one paragraph');
        const display = await mobileDisplayState(serial);
        const screen = display.size.override ?? display.size.physical;
        if (paragraph.right > screen.width) throw new Error('The link runs past the screen edge');
        const scale =
            ((display.density.override ?? display.density.physical) / 160) * display.fontScale;
        const lineHeight = REPLY_LINE_HEIGHT_DP * scale;
        if (paragraph.bottom - paragraph.top < lineHeight * 1.5)
            throw new Error('The link does not wrap onto a second line');
        await capture(environment, 'inline-link-reply', artifacts);

        await adbShell(serial, [
            'input',
            'tap',
            String(paragraph.left + Math.round(lineHeight)),
            String(Math.round(paragraph.bottom - lineHeight / 2)),
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
            browser: 'opened-from-wrapped-line',
            link: 'wraps-inside-screen',
            pageFetches: page.hits(),
            status: 'passed',
        });
    } finally {
        await fixture?.stop();
        await page.close();
    }
}
