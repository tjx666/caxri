import { currentAgentChatPromptSuggestion } from '@caxri/protocol';

import { FAKE_CLAUDE_PROMPT_SUGGESTION } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-prompt-suggestions.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hideChatKeyboard, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { observeMobileNode, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-PROMPT-SUGGESTION-01` (#3827): a Claude Chat whose latest reply carries Claude Code's suggested next
 * message shows it as a chip above the phone's composer, and tapping it fills the input without sending, the phone's
 * stand-in for Desktop's Tab. The fake Claude CLI, like Claude Code, suggests nothing after the first turn, so the
 * fixture runs two turns before the phone pairs.
 */
export async function executeMobileChatPromptSuggestionScenario(
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
        const runTurn = async (text: string): Promise<void> => {
            await chat.send({ text });
            await waitForMobile(
                () => chat.read(),
                (snapshot) =>
                    !snapshot.activeTurnId &&
                    snapshot.items.some(
                        (item) => item.type === 'agentMessage' && item.text.includes(text),
                    ),
                60_000,
            );
        };
        await runTurn('first note');
        await runTurn('second note');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                currentAgentChatPromptSuggestion(snapshot) === FAKE_CLAUDE_PROMPT_SUGGESTION,
            60_000,
        );

        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-prompt-suggestion', 60_000);
        await capture(environment, 'suggestion-offered', artifacts);

        await tapMobileCheck(serial, 'agent-chat-prompt-suggestion');
        await waitForNoCheck(serial, 'agent-chat-prompt-suggestion');
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: FAKE_CLAUDE_PROMPT_SUGGESTION,
        });
        if (!draft.exists || !draft.textMatches)
            throw new Error('Tapping the suggestion did not fill the input');
        await capture(environment, 'suggestion-filled', artifacts);
        await hideChatKeyboard(serial);
        // Filling is not sending: the Chat still holds only the two fixture turns.
        const after = await chat.read();
        const sent = after.items.filter((item) => item.type === 'userMessage').length;
        if (sent !== 2) throw new Error('Tapping the suggestion sent a message');
        await finish(environment, artifacts, {
            suggestionOffered: 'chip-shown',
            afterTap: 'input-filled-not-sent',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
