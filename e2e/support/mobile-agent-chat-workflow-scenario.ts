import type { AgentChatSnapshot, AgentChatTask } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { sendFromPhone, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The workflow runs in the Chat, oldest first, once the fake Claude reported each run's members.
 */
const workflows = (snapshot: AgentChatSnapshot): AgentChatTask[] =>
    (snapshot.tasks ?? []).filter((task) => (task.workflow?.members.length ?? 0) === 3);

const expectText = async (serial: string, checkId: string, value: string, what: string) => {
    const node = await observeMobileNode(serial, checkId, { kind: 'includes', value });
    if (!node.exists || node.textMatches !== true)
        throw new Error(`${what} does not read ${JSON.stringify(value)}`);
};

/**
 * `MOB-CHAT-WORKFLOW-01`: a Claude Code workflow run (the `Workflow` tool) on the phone. The fake Claude's `review` run
 * has phases `Inspect` and `Review` and three members, one of which fails.
 *
 * A finished run comes first, because its detail holds still for UIAutomator: its row opens the run's counts, members
 * under each phase, and result, and a member opens its own messages with Back to the run. A second run then keeps
 * working, so the status row leads with it and its timeline row names the running phase. The running detail counts its
 * elapsed time every second, which UIAutomator never reads, so it is only captured.
 */
export async function executeMobileChatWorkflowScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        chatProvider: 'claude',
        serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: 'quick workflow' });
        const finished = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                workflows(snapshot).some((task) => task.status === 'completed'),
        );
        const done = workflows(finished).find((task) => task.status === 'completed');
        if (!done?.itemId) throw new Error('The finished workflow has no timeline row');
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat');
        const doneRow = `agent-chat-work-${done.itemId}`;
        await waitForCheck(serial, doneRow);
        await capture(environment, 'workflow-row-finished', artifacts);

        await tapMobileCheckByBounds(serial, doneRow);
        await waitForCheck(serial, 'agent-chat-workflow');
        await expectText(
            serial,
            'agent-chat-workflow-summary',
            '3/3 个子 Agent · 1 个失败',
            'The finished run summary',
        );
        await waitForCheck(serial, 'agent-chat-workflow-result');
        await capture(environment, 'workflow-detail-finished', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-workflow-member');
        await waitForCheck(serial, 'agent-chat-workflow-member-detail');
        await waitForCheck(serial, 'agent-chat-task-transcript');
        await capture(environment, 'workflow-member', artifacts);
        await tapMobileCheck(serial, 'agent-chat-workflow-member-back');
        await waitForCheck(serial, 'agent-chat-workflow');
        await waitForNoCheck(serial, 'agent-chat-workflow-member-detail');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-workflow');

        await sendFromPhone(serial, 'workflow');
        const started = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                workflows(snapshot).some(
                    (task) =>
                        task.status === 'running' &&
                        task.workflow?.members.some((member) => member.status === 'running'),
                ),
        );
        const running = workflows(started).find((task) => task.status === 'running');
        if (!running?.itemId) throw new Error('The running workflow has no timeline row');
        await expectText(
            serial,
            'agent-chat-tasks-workflow-progress',
            'Review 0/2',
            'The status row progress',
        );
        const runningRow = `agent-chat-work-${running.itemId}`;
        await waitForCheck(serial, runningRow);
        await expectText(serial, `${runningRow}-activity`, 'Review', 'The running row activity');
        await capture(environment, 'workflow-running', artifacts);

        await tapMobileCheckByBounds(serial, runningRow);
        // The running detail never idles for UIAutomator; give its sheet time to slide in before the capture.
        await pause(2_000);
        await capture(environment, 'workflow-detail-running', artifacts);

        await finish(environment, artifacts, {
            finishedRow: 'shown',
            finishedDetail: 'counts-phases-members-result-shown',
            member: 'opened-and-back',
            statusRow: 'workflow-progress-shown',
            runningRow: 'phase-shown',
            source: 'deterministic-provider-fixture',
        });
    } finally {
        await fixture.stop();
    }
}
