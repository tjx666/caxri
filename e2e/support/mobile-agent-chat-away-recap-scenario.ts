import type { AgentChatSnapshot } from '@caxri/protocol';
import { currentAgentChatAwayRecap } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { sendFromPhone, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

const PROMPT = 'Fix the failing build';
const FOLLOW_UP = 'thanks';

/**
 * The first turn does tool work, so its reply is more than a brief answer an Activity excerpt already quotes whole
 * (`isBriefAgentChatReply`) and earns a recap. The second turn is the phone's follow-up.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                {
                    kind: 'tool',
                    name: 'Bash',
                    input: { command: 'bun run build', description: 'Build the project' },
                    output: 'built',
                },
                { kind: 'text', text: 'The build passes again after the import fix.' },
            ],
        },
        {
            prompt: FOLLOW_UP,
            steps: [{ kind: 'text', text: 'You are welcome.' }],
        },
    ],
};

/**
 * The recap is due three minutes after the reply and the Server sweeps every 30 seconds, so the case allows for both.
 */
const RECAP_WAIT_MS = 6 * 60_000;

const hasCurrentRecap = (snapshot: AgentChatSnapshot): boolean =>
    currentAgentChatAwayRecap(snapshot) !== undefined;

/**
 * `MOB-CHAT-AWAY-RECAP-01` (#3347): a Chat that replied while nobody watched it carries Server Core's away recap
 * (#3342), and the phone shows it after the last reply as Desktop does: a `While you were away` card. It is produced by
 * the real path, not injected: the hidden E2E Desktop window is never focused, so the reply goes unseen, and the
 * Server's sweep asks the fake Claude for the recap once it is due. The phone then opens the Chat and shows the card; a
 * message sent from the phone starts a turn, which clears it.
 */
export async function executeMobileChatAwayRecapScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // Reply before the phone pairs: a phone following the Chat counts as the user seeing the reply.
        await chat.send({ text: PROMPT });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId && snapshot.items.some((index) => index.type === 'command'),
            60_000,
        );
        const recapped = await waitForMobile(() => chat.read(), hasCurrentRecap, RECAP_WAIT_MS);
        const recap = currentAgentChatAwayRecap(recapped);
        if (!recap) throw new Error('The Server did not generate an away recap');

        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-away-recap', 60_000);
        await capture(environment, 'recap-card', artifacts);

        await sendFromPhone(serial, FOLLOW_UP);
        await waitForNoCheck(serial, 'agent-chat-away-recap', 60_000);
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.items.some(
                    (item) => item.type === 'userMessage' && item.text === FOLLOW_UP,
                ),
            60_000,
        );
        await capture(environment, 'recap-gone', artifacts);
        await finish(environment, artifacts, {
            recapLength: recap.text.length,
            recapAfterSend: 'gone',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
