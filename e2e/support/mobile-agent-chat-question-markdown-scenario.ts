import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    checkBounds,
    hasCheck,
    isInside,
    waitForCheck,
} from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const QUESTION = 'agent-chat-question-0-text';

/**
 * `MOB-CHAT-QUESTION-MARKDOWN-01`: a question the Agent writes in Markdown (`ask markdown` in the fake Claude CLI:
 * bold, inline code, and a numbered list) reads in the phone's question card as Desktop's card shows it, rendered like
 * a reply instead of one bold block with its markers. A question past three lines folds behind Show more, which opens
 * it in place. The screenshots carry the rendering; the bounds prove the folded and opened question both stay in the
 * card.
 */
export async function executeMobileChatQuestionMarkdownScenario(
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
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        // Sent from the Mac so the phone's keyboard never opens and the card shows its unfolded header.
        await chat.send({ text: 'ask markdown' });
        await waitForCheck(serial, 'agent-chat-question-0-option-0');

        const assertInCard = async (state: string) => {
            const nodes = await mobileSemantics(serial);
            const card = checkBounds(nodes, 'agent-chat-request');
            const question = checkBounds(nodes, QUESTION);
            if (!card || !question) throw new Error(`The question card is not laid out (${state})`);
            if (!isInside(question, card))
                throw new Error(`The ${state} question spills outside its card`);
            return nodes;
        };
        const folded = await assertInCard('folded');
        await capture(environment, 'question-markdown-folded', artifacts);

        const isFoldable = hasCheck(folded, `${QUESTION}-toggle`);
        if (isFoldable) {
            await tapMobileCheckByBounds(serial, `${QUESTION}-toggle`);
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) => {
                    const before = checkBounds(folded, QUESTION);
                    const after = checkBounds(nodes, QUESTION);
                    return Boolean(
                        before && after && after.bottom - after.top > before.bottom - before.top,
                    );
                },
            );
            await assertInCard('opened');
            await capture(environment, 'question-markdown-opened', artifacts);
        }

        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-0');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.requests.length === 0 &&
                !snapshot.activeTurnId &&
                agentText(snapshot).includes('You chose'),
        );

        await finish(environment, artifacts, {
            folded: isFoldable,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
