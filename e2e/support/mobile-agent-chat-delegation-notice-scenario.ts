import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';
import { runServerDatabase } from './run-server-database';

const NOTICE_TEXT = '[Caxri] Delegated reviews settled: acceptance notice';
const CHILD_TITLES = ['Review the retry design', 'Write the release notes'];

/**
 * `MOB-DELEGATION-NOTICE-01`: a settlement notice Caxri delivered to the Chat reads as compact rows naming each child
 * Session and what happened to it, not as a user bubble of raw text, and a row opens that Session.
 */
export async function executeMobileDelegationNoticeScenario(
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
        await runServerDatabase<string[]>('delegation-notice-seed', {
            testDirectory: fixture.testDirectory,
            projectId: fixture.allowedProjectId,
            sessionId: fixture.allowedSessionId,
            text: NOTICE_TEXT,
            childTitles: CHILD_TITLES,
            events: ['completed', 'question'],
        });
        await chat.send({ text: NOTICE_TEXT });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (value) =>
                value.items.some(
                    (item) => item.type === 'userMessage' && item.delegationNotice !== undefined,
                ),
        );
        const notice = snapshot.items.find(
            (item): item is Extract<typeof item, { type: 'userMessage' }> =>
                item.type === 'userMessage' && item.delegationNotice !== undefined,
        )!;
        await fixture.pair();
        await waitForCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        const noticeCheck = `agent-chat-delegation-notice-${notice.id}`;
        await waitForCheck(environment.serial, noticeCheck);
        await capture(environment, 'delegation-notice-rows', artifacts);
        // A row opens the child Session it names, leaving the parent Chat.
        const itemCheck = `agent-chat-delegation-notice-item-${notice.delegationNotice!.items[0].delegationId}`;
        await waitForCheck(environment.serial, itemCheck);
        await tapMobileCheck(environment.serial, itemCheck);
        await waitForNoCheck(environment.serial, noticeCheck);
        await capture(environment, 'delegation-notice-opened-child', artifacts);
        await finish(environment, artifacts, {
            delegationNotice: 'compact-rows-visible-and-open-child',
            source: 'synthetic-notice-delivery',
        });
    } finally {
        await fixture.stop();
    }
}
