import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * Displays the real provider's feedback envelope shapes through a deterministic fake, without invoking a host Agent.
 */
export async function executeMobileChatFeedbackScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        chatProvider: 'claude',
        serial: environment.serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: 'synthetic feedback' });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (value) =>
                !value.activeTurnId &&
                value.items.filter((item) => item.type === 'notice').length === 3,
        );
        await fixture.pair();
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(environment.serial, 'agent-chat');
        const feedback = snapshot.items.filter((item) => item.type === 'notice');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => feedback.every((item) => hasCheck(nodes, `chat-feedback-${item.id}`)),
        );
        await capture(environment, 'feedback-cards', artifacts);
        await finish(environment, artifacts, {
            feedback: 'error-warning-command-visible',
            source: 'deterministic-provider-fixture',
        });
    } finally {
        await fixture.stop();
    }
}
