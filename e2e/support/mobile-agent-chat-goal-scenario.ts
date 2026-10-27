import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    mobileNativeControlBounds,
    tapMobileCheck,
    tapMobileNativeControl,
    waitForMobile,
} from './mobile-android';

/**
 * Long enough to be cut off in the goal row, so Expand has something to show. Without `hold` the fake Codex completes
 * it in one short turn (`fake-codex-goals.ts`), so the row stops ticking and UIAutomator can read it.
 */
const OBJECTIVE =
    'Keep fixing the mobile reply window until every emulator check passes, then report what changed';

/**
 * React Native's two-button Android alert puts the first (cancel) button on the negative slot and the second on the
 * positive one.
 */
const ALERT_CANCEL = { resourceId: 'android:id/button2' };
const ALERT_CONFIRM = { resourceId: 'android:id/button1' };

/**
 * `MOB-CHAT-GOAL-01`: a Codex Chat with a goal. The goal row's Expand is its own button at the row's end, apart from
 * Clear, and opens the whole objective; Clear asks before it clears, so Cancel keeps the goal and only the confirmation
 * clears it.
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

        await tapMobileCheck(serial, 'agent-chat-goal-expand');
        await waitForCheck(serial, 'agent-chat-goal-full');
        await capture(environment, 'goal-expanded', artifacts);
        await tapMobileCheck(serial, 'agent-chat-goal-expand');
        await waitForNoCheck(serial, 'agent-chat-goal-full');

        await tapMobileCheck(serial, 'agent-chat-goal-clear');
        await waitForMobile(
            () => mobileNativeControlBounds(serial, ALERT_CANCEL),
            (bounds) => bounds !== null,
            15_000,
        );
        await capture(environment, 'goal-clear-confirm', artifacts);
        await tapMobileNativeControl(serial, ALERT_CANCEL);
        await waitForCheck(serial, 'agent-chat-goal');
        if ((await chat.read()).goal === undefined) throw new Error('Cancel must keep the goal');

        await tapMobileCheck(serial, 'agent-chat-goal-clear');
        await tapMobileNativeControl(serial, ALERT_CONFIRM);
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
