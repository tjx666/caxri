import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, checkBounds, isInside, waitForCheck } from './mobile-agent-chat-helpers';
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
 * a reply instead of one bold block with its markers. The question runs past three lines, so it folds behind Show more,
 * which opens it in place inside the card. Once answered, the transcript's record of the question renders it the same
 * way, at the record's smaller size. The screenshots carry the rendering, which the UI tree cannot show: the Markdown's
 * text runs carry no test IDs.
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

        // The fixture question runs past three lines, so the card folds it behind Show more.
        await waitForCheck(serial, `${QUESTION}-toggle`);
        await capture(environment, 'question-markdown-folded', artifacts);
        const folded = checkBounds(await mobileSemantics(serial), QUESTION);
        if (!folded) throw new Error('The folded question is not laid out');

        await tapMobileCheckByBounds(serial, `${QUESTION}-toggle`);
        const opened = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => {
                const after = checkBounds(nodes, QUESTION);
                return Boolean(after && after.bottom - after.top > folded.bottom - folded.top);
            },
        );
        await capture(environment, 'question-markdown-opened', artifacts);
        const card = checkBounds(opened, 'agent-chat-request');
        const question = checkBounds(opened, QUESTION);
        if (!card || !question || !isInside(question, card))
            throw new Error('The opened question spills outside its card');

        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-0');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.requests.length === 0 &&
                !snapshot.activeTurnId &&
                agentText(snapshot).includes('You chose'),
        );
        // The transcript keeps the answered question, rendered in Markdown as Desktop's record shows it.
        await waitForCheck(serial, 'agent-chat-answered-question-0');
        await capture(environment, 'question-markdown-answered', artifacts);

        await finish(environment, artifacts, {
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
