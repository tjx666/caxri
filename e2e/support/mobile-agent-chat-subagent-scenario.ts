import type { AgentChatSnapshot, AgentChatTask } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { typeChatDraft, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { centerOf, waitForStop } from './mobile-agent-chat-tasks-scenario';
import {
    adbShell,
    mobileDisplayState,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const subagent = (snapshot: AgentChatSnapshot): AgentChatTask | undefined =>
    (snapshot.tasks ?? []).find((task) => task.kind === 'agent');

/**
 * `MOB-CHAT-26`: a background subagent the Agent started from a phone message. Its timeline row says what it is doing
 * (`Using Grep`) and keeps its own status after the tool call that started it returned; the row opens the subagent with
 * its type, model, usage, transcript, and Stop. The fake Claude Code reports the same `task_started` and
 * `task_progress` frames as the real CLI.
 *
 * While the subagent runs, its sheet counts the elapsed time up every second, so UIAutomator never finds the idle
 * window it needs; Stop is found by its color, as in `MOB-CHAT-16`, and semantics are read once the subagent ended.
 */
export async function executeMobileChatSubagentScenario(
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
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat');

        await typeChatDraft(serial, 'background agent');
        await tapMobileCheck(serial, 'agent-chat-composer-send');
        let latest: AgentChatSnapshot | undefined;
        let started: AgentChatSnapshot;
        try {
            started = await waitForMobile(
                async () => {
                    latest = await chat.read();
                    return latest;
                },
                (snapshot) =>
                    !snapshot.activeTurnId &&
                    subagent(snapshot)?.status === 'running' &&
                    subagent(snapshot)?.lastToolName === 'Grep',
            );
        } catch (error) {
            // The task list is synthetic fixture metadata, safe to report.
            throw new Error(
                `The subagent never reported its progress: ${JSON.stringify({ activeTurnId: latest?.activeTurnId, tasks: latest?.tasks })}`,
                { cause: error },
            );
        }
        const task = subagent(started);
        if (!task?.itemId) throw new Error('The subagent has no timeline row');
        const rowId = `agent-chat-work-${task.itemId}`;
        await waitForCheck(serial, rowId);
        const row = await observeMobileNode(serial, rowId, {
            kind: 'includes',
            value: 'Using Grep',
        });
        if (!row.exists || row.textMatches !== true)
            throw new Error('The subagent row does not say what it is doing');
        await capture(environment, 'subagent-row-running', artifacts);

        await tapMobileCheckByBounds(serial, rowId);
        const display = await mobileDisplayState(serial);
        const screen = display.size.override ?? display.size.physical;
        const sheetRegion = {
            bottom: screen.height,
            left: 0,
            right: screen.width,
            top: Math.floor(screen.height * 0.2),
        };
        const stop = centerOf(await waitForStop(serial, sheetRegion));
        await capture(environment, 'subagent-detail-running', artifacts);

        await adbShell(serial, ['input', 'tap', String(stop.x), String(stop.y)]);
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                (snapshot.tasks ?? []).some(
                    (candidate) => candidate.id === task.id && candidate.status !== 'running',
                ),
        );
        await waitForNoCheck(serial, 'agent-chat-task-stop', 15_000);
        await waitForCheck(serial, 'agent-chat-task-transcript');
        const facts = await observeMobileNode(serial, 'agent-chat-task-facts', {
            kind: 'includes',
            value: 'general-purpose · fake-haiku · 12.3k tokens · 2 tool uses',
        });
        if (!facts.exists || facts.textMatches !== true)
            throw new Error('The subagent detail does not name its type, model, and usage');
        await capture(environment, 'subagent-detail-stopped', artifacts);

        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-task-transcript');
        await capture(environment, 'subagent-row-stopped', artifacts);

        await finish(environment, artifacts, {
            rowActivity: 'using-tool-shown',
            detail: 'identity-usage-transcript-shown',
            stop: 'stopped-from-phone',
            source: 'deterministic-provider-fixture',
        });
    } finally {
        await fixture.stop();
    }
}
