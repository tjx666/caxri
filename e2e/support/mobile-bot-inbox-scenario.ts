import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, tapMobileCheckByBounds } from './mobile-android';

/**
 * Two open questions Caxri Bot raised, each with one reply from the user: Caxri Bot already read the first reply and
 * has not read the second, so the cards show both read states.
 */
async function seedBotInbox(userData: string): Promise<{ readId: string; unreadId: string }> {
    const { CaxriDatabase } = await import('../../apps/server/src/domains/db');
    const database = new CaxriDatabase(join(userData, 'caxri.db'));
    try {
        const now = Date.now();
        const readId = randomUUID();
        const unreadId = randomUUID();
        database.botInbox.insert(
            readId,
            'decision',
            undefined,
            {
                title: 'Keep the legacy export format?',
                body: 'The synthetic fixture still writes the old format. Removing it simplifies the exporter.',
                options: ['Keep it', 'Remove it'],
            },
            now - 120_000,
        );
        const sequence = database.botInbox.appendReply(
            readId,
            'Remove it.',
            'desktop',
            now - 90_000,
        );
        database.botInbox.acknowledge(readId, sequence, now - 60_000);
        database.botInbox.insert(
            unreadId,
            'hands',
            undefined,
            {
                title: 'Sign in to the synthetic registry',
                body: 'Publishing the fixture package needs a registry login only you can complete.',
                options: [],
            },
            now - 30_000,
        );
        database.botInbox.appendReply(unreadId, 'Signed in.', 'desktop', now - 10_000);
        return { readId, unreadId };
    } finally {
        database.close();
    }
}

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
        const { readId, unreadId } = await seedBotInbox(join(fixture.testDirectory, 'user-data'));
        await fixture.pair();
        // "Needs you" sits in the computer menu next to Archived Sessions.
        await waitForCheck(serial, 'forget-device-button');
        await tapMobileCheck(serial, 'forget-device-button');
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
