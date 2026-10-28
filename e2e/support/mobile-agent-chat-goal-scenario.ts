import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * Long enough to be cut off in the goal row, so Expand has something to show. Without `hold` the fake Codex completes
 * it in one short turn (`fake-codex-goals.ts`), so the row stops ticking and UIAutomator can read it.
 */
const OBJECTIVE =
    'Keep fixing the mobile reply window until every emulator check passes, then report what changed';

/**
 * `MOB-CHAT-GOAL-01`: a Codex Chat with a goal. Tapping the goal row opens the whole objective with Clear under it;
 * Clear asks in a sheet before it clears, so Cancel keeps the goal and only the confirmation clears it.
 */
export async function executeMobileChatGoalScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await chat.runCommand({ name: AGENT_CHAT_GOAL_COMMAND, arguments: OBJECTIVE });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.goal?.status === 'complete' && !snapshot.activeTurnId,
        );
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-goal-expand');
        await capture(environment, 'goal-row', artifacts);

        await tapMobileCheck(serial, 'agent-chat-goal-summary');
        await waitForCheck(serial, 'agent-chat-goal-full');
        await capture(environment, 'goal-expanded', artifacts);
        await tapMobileCheck(serial, 'agent-chat-goal-summary');
        await waitForNoCheck(serial, 'agent-chat-goal-full');

        // Clear lives in the expanded goal, away from the one-tap summary row.
        await tapMobileCheck(serial, 'agent-chat-goal-summary');
        await waitForCheck(serial, 'agent-chat-goal-clear');
        await tapMobileCheck(serial, 'agent-chat-goal-clear');
        await waitForCheck(serial, 'agent-chat-goal-clear-confirm');
        await capture(environment, 'goal-clear-confirm', artifacts);
        await tapMobileCheck(serial, 'agent-chat-goal-clear-confirm-cancel');
        await waitForNoCheck(serial, 'agent-chat-goal-clear-confirm');
        await waitForCheck(serial, 'agent-chat-goal');
        if ((await chat.read()).goal === undefined) throw new Error('Cancel must keep the goal');

        await tapMobileCheck(serial, 'agent-chat-goal-clear');
        await tapMobileCheck(serial, 'agent-chat-goal-clear-confirm-confirm');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.goal === undefined,
        );
        await waitForNoCheck(serial, 'agent-chat-goal');
        await capture(environment, 'goal-cleared', artifacts);

        await finish(environment, artifacts, {
            cancel: 'kept',
            clear: 'confirmed',
            expand: 'opened',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
