import { delegatedTaskPointer } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-19`: a delegated task pointer reads as a "Delegated task" bubble with its raw instruction collapsed, and
 * the Session list labels its groups. The pointer is synthetic; no delegation record exists, so the bubble shows the
 * source-less fallback.
 */
export async function executeMobileChatDelegatedTaskScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        serial: environment.serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({
            text: delegatedTaskPointer('/tmp/caxri-delegation/task.md', 'delegation-synthetic-1'),
        });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (value) =>
                !value.activeTurnId &&
                value.items.some((item) => item.type === 'userMessage' && item.delegatedTask),
        );
        const pointer = snapshot.items.find(
            (item) => item.type === 'userMessage' && item.delegatedTask,
        )!;
        await fixture.pair();
        // The finished reply leaves the Session unread, so it sits under Needs attention.
        await waitForCheck(environment.serial, 'session-group-attention');
        await capture(environment, 'session-groups', artifacts);
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(environment.serial, `agent-chat-delegated-${pointer.id}`);
        await capture(environment, 'delegated-collapsed', artifacts);
        await tapMobileCheck(environment.serial, `agent-chat-delegated-toggle-${pointer.id}`);
        await capture(environment, 'delegated-expanded', artifacts);
        await finish(environment, artifacts, {
            delegatedTask: 'collapsed-and-expanded-visible',
            source: 'synthetic-pointer',
        });
    } finally {
        await fixture.stop();
    }
}
