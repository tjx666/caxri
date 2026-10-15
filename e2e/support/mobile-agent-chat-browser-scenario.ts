import { FAKE_CODEX_WEB_LINK_LABEL } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-replies.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileDisplayState,
    mobileNativeControlBounds,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import { MOBILE_BROWSER_PAGE_TITLE, startMobileBrowserPage } from './mobile-browser-page-fixture';

/**
 * Taps the reply's only link near the start of its first line. Rendered Markdown is one native text view whose text is
 * the link label; the label wraps, and a tap at the view's center could fall past the end of a short last line, where
 * no link span is.
 */
async function tapReplyLink(serial: string): Promise<void> {
    const bounds = await waitForMobile(
        () => mobileNativeControlBounds(serial, { text: FAKE_CODEX_WEB_LINK_LABEL }),
        (candidate) => candidate !== null,
        15_000,
    );
    if (!bounds) throw new Error('The reply link is not laid out');
    const x = bounds.left + Math.min(40, Math.floor((bounds.right - bounds.left) / 4));
    const y = bounds.top + Math.min(24, Math.floor((bounds.bottom - bounds.top) / 2));
    await adbShell(serial, ['input', 'tap', String(x), String(y)]);
}

/**
 * `MOB-CHAT-17`: an `http` link in an Agent reply opens Caxri's in-app browser over the Chat, on a synthetic page the
 * scenario serves from this Mac's loopback interface. The bottom toolbar shows close, the page title pill with its
 * menu, and reload; the menu opens and Back closes only the menu; reload fetches the page again; close returns to the
 * same Chat.
 */
export async function executeMobileChatBrowserScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const page = await startMobileBrowserPage();
    let fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>> | undefined;
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        // The Mac sends the message: `adb input text` cannot type the URL's colon and slashes reliably.
        await chat.send({ text: `weblink ${page.url}` });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes(FAKE_CODEX_WEB_LINK_LABEL) && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'link-reply', artifacts);

        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;
        await tapReplyLink(serial);
        await waitForCheck(serial, 'in-app-browser');
        await waitForMobile(
            () => page.hits(),
            (hits) => hits >= 1,
        );
        for (const control of [
            'in-app-browser-toolbar',
            'in-app-browser-close',
            'in-app-browser-menu',
            'in-app-browser-reload',
        ])
            // eslint-disable-next-line no-await-in-loop -- one screen, checked control by control.
            await waitForCheck(serial, control);
        // The title pill switches from the host to the page title once the page reports it. The loaded WebView exposes
        // the same title as its own text, so only the pill's text view counts.
        const pillTitle = await waitForMobile(
            () =>
                mobileNativeControlBounds(serial, {
                    className: 'android.widget.TextView',
                    text: MOBILE_BROWSER_PAGE_TITLE,
                }),
            (candidate) => candidate !== null,
            15_000,
        );
        const toolbar = checkBounds(await mobileSemantics(serial), 'in-app-browser-toolbar');
        if (!pillTitle || !toolbar) throw new Error('The browser toolbar is not laid out');
        if (pillTitle.top < toolbar.top || pillTitle.bottom > toolbar.bottom)
            throw new Error('The page title is not in the toolbar pill');
        const display = await mobileDisplayState(serial);
        const screen = display.size.override ?? display.size.physical;
        // X's toolbar floats over the bottom of the page rather than taking a bar of its own at the top.
        if (toolbar.top < screen.height * 0.8)
            throw new Error('The browser toolbar is not at the bottom of the screen');
        await capture(environment, 'browser', artifacts);

        await tapMobileCheckByBounds(serial, 'in-app-browser-menu');
        await waitForCheck(serial, 'in-app-browser-copy');
        await waitForCheck(serial, 'in-app-browser-open-external');
        await capture(environment, 'browser-menu', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'in-app-browser-copy');
        await waitForCheck(serial, 'in-app-browser');

        const loaded = page.hits();
        await tapMobileCheckByBounds(serial, 'in-app-browser-reload');
        await waitForMobile(
            () => page.hits(),
            (hits) => hits > loaded,
        );

        await tapMobileCheckByBounds(serial, 'in-app-browser-close');
        await waitForNoCheck(serial, 'in-app-browser');
        await waitForCheck(serial, 'agent-chat');
        await capture(environment, 'browser-closed', artifacts);
        await recording?.stop();
        recording = undefined;

        await finish(environment, artifacts, {
            browser: 'opened-in-app',
            close: 'returned-to-chat',
            menu: 'opened-and-dismissed',
            pageFetches: page.hits(),
            pillTitle: 'page-title',
            toolbar: 'bottom',
            reload: 'refetched',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture?.stop();
        await page.close();
    }
}
