import type { AgentChatSnapshot, AgentChatTask } from '@caxri/protocol';

import type { MobileAcceptanceFixture } from './mobile-acceptance-fixture';
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
 * How long a sheet that never idles for UIAutomator gets to slide in before its capture.
 */
const SHEET_SETTLE_MS = 2_000;

/**
 * The fake Claude's `review` run: phases `Inspect` and `Review` and three members. Running, the first member has
 * finished, the second works, and the third waits; finished, the third member failed.
 */
const RUNNING_STATES = ['completed', 'running', 'queued'];
const FINISHED_STATES = ['completed', 'completed', 'failed'];

const workflowIn = (snapshot: AgentChatSnapshot, states: readonly string[]) =>
    (snapshot.tasks ?? []).find(
        (task): task is AgentChatTask & { itemId: string } =>
            task.itemId !== undefined &&
            task.workflow?.members.map((member) => member.status).join(',') === states.join(','),
    );

const expectText = async (serial: string, checkId: string, value: string, what: string) => {
    const node = await observeMobileNode(serial, checkId, { kind: 'includes', value });
    if (!node.exists || node.textMatches !== true)
        throw new Error(`${what} does not read ${JSON.stringify(value)}`);
};

const openChat = async (fixture: MobileAcceptanceFixture, serial: string) => {
    if (!fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
    await fixture.pair();
    await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
    await waitForCheck(serial, 'agent-chat');
};

const claudeFixture = (serial: string) =>
    createMobileAcceptanceFixture({ mode: 'agent-chat', chatProvider: 'claude', serial });

/**
 * `MOB-CHAT-WORKFLOW-01`: a finished Claude Code workflow run (the `Workflow` tool). Its timeline row opens the run's
 * counts, its members under each phase, and its result; a member opens its own messages, and Back returns to the run. A
 * finished detail holds still, so UIAutomator reads it.
 */
export async function executeMobileChatWorkflowFinishedScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await claudeFixture(serial);
    try {
        const chat = fixture.agentChat;
        if (!chat) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: 'quick workflow' });
        const finished = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                workflowIn(snapshot, FINISHED_STATES)?.status === 'completed',
        );
        const run = workflowIn(finished, FINISHED_STATES);
        if (!run) throw new Error('The finished workflow has no timeline row');
        await openChat(fixture, serial);
        const row = `agent-chat-work-${run.itemId}`;
        await waitForCheck(serial, row);
        await capture(environment, 'workflow-row-finished', artifacts);

        await tapMobileCheckByBounds(serial, row);
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
        await capture(environment, 'workflow-detail-after-back', artifacts);

        await finish(environment, artifacts, {
            members: FINISHED_STATES.join(','),
            detail: 'counts-phases-members-result-shown',
            member: 'opened-and-back',
            source: 'deterministic-provider-fixture',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-WORKFLOW-02`: a workflow run that keeps working after the turn ended. The status row leads with the
 * workflow glyph and the running phase's progress, the Background work list draws the run with its progress, its
 * timeline row names the running phase, and its detail lists the members under each phase. The list and the detail
 * count elapsed time every second, which UIAutomator never reads, so those two are only captured.
 */
export async function executeMobileChatWorkflowRunningScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await claudeFixture(serial);
    try {
        const chat = fixture.agentChat;
        if (!chat) throw new Error('Chat fixture is unavailable');
        await openChat(fixture, serial);
        await sendFromPhone(serial, 'workflow');
        const started = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                workflowIn(snapshot, RUNNING_STATES)?.status === 'running',
        );
        const run = workflowIn(started, RUNNING_STATES);
        if (!run) throw new Error('The running workflow has no timeline row');
        await expectText(
            serial,
            'agent-chat-tasks-workflow-progress',
            'Review 0/2',
            'The status row progress',
        );
        const row = `agent-chat-work-${run.itemId}`;
        await waitForCheck(serial, row);
        await expectText(serial, `${row}-activity`, 'Review', 'The running row activity');
        await capture(environment, 'workflow-running', artifacts);

        await tapMobileCheck(serial, 'agent-chat-tasks');
        await pause(SHEET_SETTLE_MS);
        await capture(environment, 'workflow-task-list', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-tasks-sheet');

        await tapMobileCheckByBounds(serial, row);
        await pause(SHEET_SETTLE_MS);
        await capture(environment, 'workflow-detail-running', artifacts);

        await finish(environment, artifacts, {
            members: RUNNING_STATES.join(','),
            statusRow: 'workflow-progress-shown',
            runningRow: 'phase-shown',
            source: 'deterministic-provider-fixture',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
