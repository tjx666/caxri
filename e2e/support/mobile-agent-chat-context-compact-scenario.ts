import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    hideChatKeyboard,
    typeChatDraft,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import { observeMobileNode, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * The draft typed before Compact; the button must leave it in the composer.
 */
const DRAFT = 'keep this draft';

/**
 * `MOB-CHAT-CONTEXT-COMPACT-01` (#3314): a Claude Chat whose context is nearly full shows the context notice above the
 * phone's composer with a Compact button in place of Usage; tapping it compacts the conversation and keeps the draft in
 * the composer, after which the notice and its button are gone.
 */
export async function executeMobileChatContextCompactScenario(
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
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // The fake Claude reports most of its context window used for a prompt that asks for a large context.
        await chat.send({ text: 'large context please' });
        const full = await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && snapshot.usage?.contextWindow !== undefined,
        );
        // The fake reports 140k cached tokens of a 200k window, past the share where compacting is suggested.
        if ((full.usage?.totalTokens ?? 0) < 140_000)
            throw new Error('The fake did not report a nearly full context');
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-context-notice-compact', 60_000);
        await typeChatDraft(serial, DRAFT);
        await hideChatKeyboard(serial);
        await capture(environment, 'notice-compact', artifacts);

        await tapMobileCheck(serial, 'agent-chat-context-notice-compact');
        const compacted = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'notice' && item.kind === 'compacted'),
            60_000,
        );
        const notice = compacted.items.findLast(
            (item) => item.type === 'notice' && item.kind === 'compacted',
        );
        if (!notice) throw new Error('The compaction did not finish');
        await waitForCheck(serial, `conversation-event-${notice.id}`);
        await waitForNoCheck(serial, 'agent-chat-context-notice', 60_000);
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: DRAFT,
        });
        if (!draft.exists || !draft.textMatches) throw new Error('Compact cleared the draft');
        await capture(environment, 'compacted', artifacts);
        await finish(environment, artifacts, {
            compacted: 'notice-present',
            draft: 'kept',
            contextTokensBefore: full.usage?.totalTokens,
            contextTokensAfter: compacted.usage?.totalTokens,
            contextWindow: full.usage?.contextWindow,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
