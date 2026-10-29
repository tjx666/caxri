import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, tapMobileCheckByBounds } from './mobile-android';
import { runServerDatabase as runServerDatabase } from './run-server-database';

/**
 * `MOB-CHAT-33` and `MOB-CHAT-34`: a control phone opens the Bot Inbox ("Needs you") from the computer menu. Each card
 * names Caxri Bot in its reply read state ("Read by Caxri Bot", "Delivered to Caxri Bot"), and the reply composer's
 * placeholder addresses Caxri Bot, in the case's app language.
 */
export async function executeMobileBotInboxScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const { readId, unreadId } = await runServerDatabase<{ readId: string; unreadId: string }>(
            'bot-inbox-seed',
            {
                userData: join(fixture.testDirectory, 'user-data'),
            },
        );
        await fixture.pair();
        // "Needs you" sits in the computer menu next to Archived Sessions.
        await waitForCheck(serial, 'computer-menu-button');
        await tapMobileCheck(serial, 'computer-menu-button');
        await waitForCheck(serial, 'bot-inbox-action');
        await tapMobileCheck(serial, 'bot-inbox-action');
        await waitForCheck(serial, `bot-inbox-reply-state-${readId}`);
        await waitForCheck(serial, `bot-inbox-reply-state-${unreadId}`);
        await capture(environment, 'reply-states', artifacts);

        await tapMobileCheckByBounds(serial, `bot-inbox-reply-${unreadId}`);
        await waitForCheck(serial, `bot-inbox-reply-input-${unreadId}`);
        await capture(environment, 'reply-composer', artifacts);
        await tapMobileCheckByBounds(serial, `bot-inbox-reply-cancel-${unreadId}`);
        await waitForCheck(serial, `bot-inbox-reply-${unreadId}`);
        await finish(environment, artifacts, {
            replyStates: 'read-and-delivered-visible',
            replyComposer: 'placeholder-visible',
        });
    } finally {
        await fixture.stop();
    }
}
