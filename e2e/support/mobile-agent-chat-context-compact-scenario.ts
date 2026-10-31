import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-CONTEXT-COMPACT-01` (#3314): a Claude Chat whose context is nearly full shows the context notice above the
 * phone's composer with a Compact button in place of Usage; tapping it compacts the conversation, after which the
 * notice and its button are gone.
 */
export async function executeMobileChatContextCompactScenario(
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
        // The fake Claude reports most of its context window used for a prompt that asks for a large context.
        await chat.send({ text: 'large context please' });
        const full = await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && snapshot.usage?.contextWindow !== undefined,
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-context-notice-compact', 60_000);
        await capture(environment, 'notice-compact', artifacts);

        await tapMobileCheck(serial, 'agent-chat-context-notice-compact');
        const compacted = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.operation !== 'compacting' &&
                snapshot.items.some((item) => item.type === 'notice' && item.kind === 'compacted'),
            60_000,
        );
        await waitForNoCheck(serial, 'agent-chat-context-notice-compact', 60_000);
        await capture(environment, 'compacted', artifacts);
        await finish(environment, artifacts, {
            compacted: 'notice-present',
            contextTokensBefore: full.usage?.totalTokens,
            contextTokensAfter: compacted.usage?.totalTokens,
            contextWindow: full.usage?.contextWindow,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
