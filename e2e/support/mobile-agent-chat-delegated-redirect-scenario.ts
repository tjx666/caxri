import { delegatedRedirectMessage } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';
import { runServerDatabase } from './run-server-database';

const DELEGATION = `dispatch-${'c'.repeat(64)}`;
const OPERATION = 'acceptance-redirect-one';
const CALLER_TITLE = 'Retry planner';
const DIRECTION = 'Focus on the retry backoff only.';

/**
 * `MOB-DELEGATION-REDIRECT-01`: a redirect of a running delegated task reads in the child's Chat as "Updated direction
 * from <delegating Session>" with the new direction, not as the raw envelope, a "Delegated task" card, or a user
 * bubble.
 */
export async function executeMobileDelegatedRedirectScenario(
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
        await runServerDatabase('delegation-redirect-seed', {
            testDirectory: fixture.testDirectory,
            projectId: fixture.allowedProjectId,
            sessionId: fixture.allowedSessionId,
            delegationId: DELEGATION,
            operationId: OPERATION,
            callerTitle: CALLER_TITLE,
            text: DIRECTION,
        });
        await chat.send({ text: delegatedRedirectMessage(DELEGATION, OPERATION, DIRECTION) });
        // The fixture's turn keeps running, so wait for the stamped message rather than an idle Chat.
        const snapshot = await waitForMobile(
            () => chat.read(),
            (value) =>
                value.items.some(
                    (item) => item.type === 'userMessage' && item.delegatedTask?.redirect,
                ),
        );
        const redirect = snapshot.items.find(
            (item): item is Extract<typeof item, { type: 'userMessage' }> =>
                item.type === 'userMessage' && Boolean(item.delegatedTask?.redirect),
        )!;
        await fixture.pair();
        await waitForCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(environment.serial, `agent-chat-delegated-${redirect.id}`);
        await capture(environment, 'delegated-redirect', artifacts);
        await finish(environment, artifacts, {
            delegatedRedirect: 'updated-direction-from-session-visible',
            source: 'synthetic-redirect-claim',
        });
    } finally {
        await fixture.stop();
    }
}
