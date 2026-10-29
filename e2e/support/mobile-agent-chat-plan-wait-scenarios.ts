import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-USAGE-WAIT-01` (#3022): a Claude Chat that used up its 5-hour limit and waits to continue shows a clock in
 * the Sessions list, filed under Idle; cancelling the wait from the Mac clears the clock. Sent from the Mac so the
 * phone stays on the list.
 */
export async function executeMobileChatUsageWaitScenario(
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
        // The fake Claude answers this prompt with a rejected 5-hour limit, so the Chat waits for the reset.
        await chat.send({ text: 'usage exhausted' });
        await waitForCheck(serial, 'session-status-usage-wait');
        await capture(environment, 'usage-wait', artifacts);

        await chat.cancelUsageWait();
        await waitForNoCheck(serial, 'session-status-usage-wait');
        await capture(environment, 'usage-wait-ended', artifacts);

        await finish(environment, artifacts, { clock: 'shown-then-cleared', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-PLAN-APPROVAL-01` (#3031): a Codex Chat in plan mode ends its turn with a proposed plan, and the phone's
 * Chat shows `Start with this plan?`. Keep Planning hides it; the next plan's Start Building leaves plan mode and
 * starts the build turn.
 */
export async function executeMobileChatPlanApprovalScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await chat.configure({ planMode: true });
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await chat.send({ text: 'proposeplan refactor the parser' });
        await waitForCheck(serial, 'agent-chat-plan-approval');
        await capture(environment, 'plan-card', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-approval-decline');
        await waitForNoCheck(serial, 'agent-chat-plan-approval');
        if (!(await chat.read()).planMode) throw new Error('Keep Planning must leave plan mode on');
        await capture(environment, 'plan-kept', artifacts);

        await chat.send({ text: 'proposeplan again' });
        await waitForCheck(serial, 'agent-chat-plan-approval');
        await tapMobileCheckByBounds(serial, 'agent-chat-approval-accept');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.planMode !== true &&
                agentText(snapshot).length > 0 &&
                snapshot.items.some(
                    (item) => item.type === 'userMessage' && item.text === 'Implement the plan.',
                ),
        );
        await waitForNoCheck(serial, 'agent-chat-plan-approval');
        await capture(environment, 'plan-started', artifacts);

        await finish(environment, artifacts, {
            keepPlanning: 'hides-card-keeps-plan-mode',
            startBuilding: 'leaves-plan-mode-and-builds',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
