import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, hasCheck, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-LIST-APPROVAL-01` (Codex) and `MOB-CHAT-LIST-APPROVAL-02` (Claude Code): a Chat waiting on an approval
 * shows the approval card under its row in the Sessions list, with no "handled in Terminal" hint, and approving it
 * there lets the Agent continue without opening the Chat. `MOB-CHAT-LIST-QUESTION-01` shares the Claude Code entry and
 * runs the question flow instead.
 */
export async function executeMobileChatListApprovalScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    provider: 'claude' | 'codex',
): Promise<void> {
    if (environment.caseId === 'MOB-CHAT-LIST-QUESTION-01')
        return executeMobileChatListQuestionScenario(environment, artifacts);
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

/**
 * `MOB-CHAT-LIST-QUESTION-01`: a Claude Code Chat asking an `AskUserQuestion` shows the question card under its row in
 * the Sessions list, framed by the amber attention border, and answering both questions there finishes the turn without
 * opening the Chat.
 */
async function executeMobileChatListQuestionScenario(
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
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // Sent from the Mac so the phone stays on the Sessions list the whole time.
        await chat.send({ text: 'ask recommended' });
        await waitForCheck(serial, 'session-chat-requests');
        await waitForCheck(serial, 'agent-chat-question-0-option-0');
        await capture(environment, 'list-question', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-0');
        await waitForCheck(serial, 'agent-chat-question-1-option-0');
        await tapMobileCheckByBounds(serial, 'agent-chat-question-1-option-0');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.requests.length === 0 &&
                !snapshot.activeTurnId &&
                agentText(snapshot).includes('You chose'),
        );
        await waitForNoCheck(serial, 'session-chat-requests');
        await capture(environment, 'list-answered', artifacts);

        await finish(environment, artifacts, {
            question: 'answered-from-list',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
