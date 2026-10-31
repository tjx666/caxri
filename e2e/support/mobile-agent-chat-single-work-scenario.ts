import type { AgentChatSnapshot } from '@caxri/protocol';
import { draculaTheme } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { adbShell, mobileColorBounds, tapMobileCheck, waitForMobile } from './mobile-android';

const PROMPT = 'Build the release package';
const NARRATION = 'Packaging now; this takes a while.';

/**
 * A turn whose trailing work is one command that keeps running, so the phone shows that run's live summary.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                { kind: 'text', text: NARRATION },
                {
                    kind: 'tool',
                    name: 'Bash',
                    input: { command: 'sleep 900', description: 'Build the DMG' },
                    output: 'done',
                    durationMs: 900_000,
                },
            ],
        },
    ],
};

const hasRunningCommand = (snapshot: AgentChatSnapshot): boolean =>
    Boolean(snapshot.activeTurnId) &&
    snapshot.items.some((item) => item.type === 'command' && item.status === 'running');

/**
 * The Chat timeline on the 1080x2400 emulator, below the Session tabs and above the composer's activity line. The work
 * summary's card is the only thing inside it drawn in the theme's border color.
 */
const TIMELINE_REGION = { bottom: 1550, left: 0, right: 1080, top: 680 };

/**
 * A running turn's spinner and elapsed clock keep the screen changing, so UIAutomator never idles and cannot read the
 * open Chat; the card is found by its border pixels instead.
 */
const cardBounds = (serial: string) =>
    mobileColorBounds(serial, TIMELINE_REGION, draculaTheme.colors.border, 4);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `MOB-CHAT-SINGLE-WORK-01` (#3325): a running turn whose trailing work is one call keeps its live summary, and that
 * summary used to expand into a single row repeating its own title (`Waiting for agents` under `Waiting for agents`).
 * The summary of one call now opens that call's detail, as Desktop's does. The card growing taller after the tap means
 * it expanded into that repeated row.
 */
export async function executeMobileChatSingleWorkScenario(
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
        await fixture.pair();
        await chat.send({ text: PROMPT });
        await waitForMobile(() => chat.read(), hasRunningCommand, 60_000);
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        const card = await waitForMobile(() => cardBounds(serial), Boolean, 30_000);
        if (!card) throw new Error('The work summary card is not drawn');
        await pause(1000);
        await capture(environment, 'summary', artifacts);

        const header = Math.min(card.bottom - card.top, 130);
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.floor((card.left + card.right) / 2)),
            String(Math.floor(card.top + header / 2)),
        ]);
        await pause(1500);
        await capture(environment, 'after-tap', artifacts);
        const after = await cardBounds(serial);
        const outcome =
            after && after.bottom - after.top > card.bottom - card.top + 20
                ? 'repeated-row'
                : 'detail';
        await finish(environment, artifacts, {
            outcome,
            status: outcome === 'detail' ? 'passed' : 'failed',
        });
        if (outcome !== 'detail')
            throw new Error('The one-call summary expanded into a row repeating its title');
    } finally {
        await fixture.stop();
    }
}
