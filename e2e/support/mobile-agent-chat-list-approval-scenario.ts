import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, hasCheck, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-LIST-APPROVAL-01` (Codex) and `MOB-CHAT-LIST-APPROVAL-02` (Claude Code): a Chat waiting on an approval
 * shows the approval card under its row in the Sessions list, with no "handled in Terminal" hint, and approving it
 * there lets the Agent continue without opening the Chat.
 */
export async function executeMobileChatListApprovalScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    provider: 'claude' | 'codex',
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        ...(provider === 'claude' && { chatProvider: 'claude' as const }),
        mode: 'agent-chat',
        serial,
    });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // Sent from the Mac so the phone stays on the Sessions list the whole time.
        await chat.send({ text: provider === 'claude' ? 'planmode' : 'approve' });
        await waitForCheck(serial, 'session-chat-requests');
        await waitForCheck(serial, 'agent-chat-approval-accept');
        if (hasCheck(await mobileSemantics(serial), 'attention-open-terminal-fallback'))
            throw new Error('A Chat approval must not point the user at a Terminal');
        await capture(environment, 'list-approval', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-approval-accept');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.requests.length === 0 &&
                !snapshot.activeTurnId &&
                agentText(snapshot).length > 0,
        );
        await waitForNoCheck(serial, 'session-chat-requests');
        await capture(environment, 'list-approved', artifacts);

        await finish(environment, artifacts, {
            approval: 'accepted-from-list',
            terminalHint: 'absent',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
