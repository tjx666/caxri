import type { AgentUsageReadout } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-USAGE-01`: after one Claude reply, the phone's composer ends its model row with the quiet context ring, and
 * tapping it opens the Session usage sheet with the context against the window, the conversation's tokens and estimated
 * cost, and the prompt cache's state and hit rate.
 */
export async function executeMobileSessionUsageScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: 'hi there' });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (current) =>
                !current.activeTurnId &&
                current.items.some((item) => item.type === 'agentMessage') &&
                current.usage?.contextWindow !== undefined,
        );
        const readout = await waitForMobile(
            () =>
                pageRequest<AgentUsageReadout | null>(fixture.running.page, 'terminal.agentUsage', {
                    terminalId: chat.terminalId,
                }),
            (current) => (current?.tokens.total ?? 0) > 0,
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-usage-button');
        await capture(environment, 'composer-ring', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-usage-button');
        await waitForCheck(serial, 'agent-chat-usage-sheet');
        await waitForCheck(serial, 'agent-chat-usage-context');
        await waitForCheck(serial, 'agent-chat-usage-cost');
        await waitForCheck(serial, 'agent-chat-usage-hitRate');
        await capture(environment, 'usage-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-usage-done');
        await waitForNoCheck(serial, 'agent-chat-usage-sheet');
        await capture(environment, 'usage-closed', artifacts);
        await finish(environment, artifacts, {
            contextTokens: snapshot.usage?.totalTokens,
            contextWindow: snapshot.usage?.contextWindow,
            conversationTokens: readout?.tokens.total,
            hasCost: readout ? readout.unpricedModels.length < readout.models.length : false,
        });
    } finally {
        await fixture.stop();
    }
}
