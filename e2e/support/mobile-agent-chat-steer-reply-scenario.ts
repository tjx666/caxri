import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * The thought the fake Codex answers a `ponder` steer with, before it goes back to work (`fake-codex-steer.ts`).
 */
const steerReplyThought = (snapshot: AgentChatSnapshot) => {
    const steer = snapshot.items.findIndex(
        (item) => item.type === 'userMessage' && item.text.includes('ponder'),
    );
    return steer === -1
        ? undefined
        : snapshot.items.slice(steer).find((item) => item.type === 'reasoning');
};

/**
 * `MOB-CHAT-STEER-REPLY-01`: a message steered into a running turn that the Agent answers only in its thinking before
 * running more tools. That thought is the only answer the user gets, so the phone shows it open under its own row, as
 * Desktop does, instead of folding it into the summary of the tool calls after it. Once the turn ends, the thought
 * stays outside the turn's fold, still open.
 */
export async function executeMobileChatSteerReplyScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await chat.send({ text: 'slow please' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => Boolean(snapshot.activeTurnId),
        );
        await chat.send({ text: 'Is a WebView slower? ponder', delivery: 'steer' });
        const running = await waitForMobile(
            () => chat.read(),
            // The two commands after the thought must be in view too, so the frame shows the thought kept out of them.
            (snapshot) =>
                Boolean(steerReplyThought(snapshot)) &&
                snapshot.items.some(
                    (item) => item.type === 'command' && item.command.includes('git log'),
                ),
            30_000,
        );
        const thought = steerReplyThought(running);
        if (!thought) throw new Error('The steer was not answered with a thought');
        // A running turn's shimmer keeps UIAutomator from settling, so this frame is a capture only.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await capture(environment, 'running-steer-reply', artifacts);

        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId,
            60_000,
        );
        let isOpen = true;
        try {
            await waitForCheck(serial, `agent-chat-steer-reply-${thought.id}`);
        } catch {
            isOpen = false;
        }
        await capture(environment, 'finished-steer-reply', artifacts);
        await finish(environment, artifacts, {
            outcome: isOpen ? 'thought-open' : 'thought-folded',
            status: isOpen ? 'passed' : 'failed',
        });
        if (!isOpen) throw new Error('The steer reply thought is not shown open');
    } finally {
        await fixture.stop();
    }
}
