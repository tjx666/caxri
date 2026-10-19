import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-23`: while a running Claude turn shows nothing after the user's message (the fake Claude's `think quietly`
 * held by a `hold-reply` file, as hidden reasoning holds it), the phone holds the reply's place with three dots under
 * the message instead of a blank screen; the dots give way to the reply once it streams.
 */
export async function executeMobileReplyPlaceholderScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const hold = join(fixture.testDirectory, 'hold-reply');
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await writeFile(hold, '');
        await chat.send({ text: 'think quietly' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.activeTurnId !== undefined,
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-reply-placeholder');
        await capture(environment, 'awaiting-reply', artifacts);

        await rm(hold);
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        await waitForNoCheck(serial, 'agent-chat-reply-placeholder');
        await capture(environment, 'reply-arrived', artifacts);
        await finish(environment, artifacts, { placeholder: 'shown-then-replaced' });
    } finally {
        await rm(hold, { force: true });
        await fixture.stop();
    }
}
