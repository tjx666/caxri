import { FAKE_CODEX_QUOTE_DRAFT } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-quote-draft.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    hideChatKeyboard,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * `MOB-CHAT-QUOTE-COPY-01`: an Agent reply quoting a draft for the user to send on. The quote shows Copy in its corner;
 * tapping it confirms in place and puts the draft on the clipboard without its `>` markers, line breaks kept, which
 * pasting it back into the composer proves.
 */
export async function executeMobileChatQuoteCopyScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await sendFromPhone(serial, 'quotedraft');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('Done.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await hideChatKeyboard(serial);
        // Captured before looking for Copy, so a build without it still records the quote it left without one.
        await capture(environment, 'quote-reply', artifacts);
        await waitForCheck(serial, 'conversation-quote-0-copy');

        await tapMobileCheckByBounds(serial, 'conversation-quote-0-copy');
        await waitForCheck(serial, 'conversation-quote-0-copy-copied');
        await capture(environment, 'quote-copied', artifacts);
        // Android's clipboard preview appears over the composer after a copy: tap it away before pasting.
        await adbShell(serial, ['input', 'tap', '540', '1000']);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_PASTE']);
        await waitForMobile(
            () =>
                observeMobileNode(serial, 'agent-chat-composer-input', {
                    kind: 'equals',
                    value: FAKE_CODEX_QUOTE_DRAFT,
                }),
            (node) => node.exists && node.textMatches === true,
        );
        await hideChatKeyboard(serial);
        await capture(environment, 'quote-pasted', artifacts);
        await finish(environment, artifacts, {
            copiedCharacters: FAKE_CODEX_QUOTE_DRAFT.length,
            quoteCopy: 'draft-pasted-without-markers',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
