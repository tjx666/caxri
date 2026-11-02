import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { draculaTheme } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { adbShell, mobileColorBounds, tapMobileCheck, waitForMobile } from './mobile-android';

const PROMPT = 'Merge the pull request';
const HOLD_FILE = 'between-calls';

/**
 * A running turn that finished several quick calls and now waits for the model's next step, as a turn does while the
 * Agent thinks between tool calls: the work summary stays open and marked running with no call in flight.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                ...['git status --short', 'git log -1', 'git fetch', 'git branch -vv'].map(
                    (command) => ({
                        kind: 'tool' as const,
                        name: 'Bash',
                        input: { command },
                        output: '',
                        durationMs: 100,
                    }),
                ),
                { kind: 'hold', file: HOLD_FILE },
                { kind: 'text', text: 'Merged.' },
            ],
        },
    ],
};

const isBetweenCalls = (snapshot: AgentChatSnapshot): boolean => {
    const commands = snapshot.items.filter((item) => item.type === 'command');
    return (
        Boolean(snapshot.activeTurnId) &&
        commands.length === 4 &&
        commands.every((item) => item.status !== 'running')
    );
};

/**
 * The Chat timeline on the 1080x2400 emulator, below the Session tabs and above the composer's activity line.
 */
const TIMELINE_REGION = { bottom: 1550, left: 0, right: 1080, top: 680 };

const cardBounds = (serial: string) =>
    mobileColorBounds(serial, TIMELINE_REGION, draculaTheme.colors.border, 4);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The card's height every half second, one sample after another: each read waits for the previous one.
 */
const sampleCardHeights = async (serial: string, count: number): Promise<number[]> => {
    if (count === 0) return [];
    await pause(500);
    const bounds = await cardBounds(serial);
    return [
        bounds ? bounds.bottom - bounds.top : 0,
        ...(await sampleCardHeights(serial, count - 1)),
    ];
};

/**
 * `MOB-CHAT-WORK-GROUP-OPEN-01`: tapping a running turn's work summary between tool calls opened it for a moment and
 * then folded it again on its own. The summary must stay expanded while the turn keeps running.
 */
export async function executeMobileChatWorkGroupOpenScenario(
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
    const holdPath = join(fixture.testDirectory, HOLD_FILE);
    await writeFile(holdPath, '');
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        await chat.send({ text: PROMPT });
        await waitForMobile(() => chat.read(), isBetweenCalls, 60_000);
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        const card = await waitForMobile(() => cardBounds(serial), Boolean, 30_000);
        if (!card) throw new Error('The work summary card is not drawn');
        await pause(1000);
        await capture(environment, 'collapsed', artifacts);

        const collapsedHeight = card.bottom - card.top;
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.floor((card.left + card.right) / 2)),
            String(Math.floor(card.top + collapsedHeight / 2)),
        ]);
        // Sample past several ticks of the running turn's elapsed clock, which redraws the screen every second.
        const heights = await sampleCardHeights(serial, 8);
        await capture(environment, 'expanded', artifacts);
        const outcome = heights.every((height) => height > collapsedHeight * 2)
            ? 'stays-expanded'
            : heights.some((height) => height > collapsedHeight * 2)
              ? 'folded-again'
              : 'not-expanded';
        await finish(environment, artifacts, {
            collapsedHeight,
            heights,
            outcome,
            status: outcome === 'stays-expanded' ? 'passed' : 'failed',
        });
        if (outcome !== 'stays-expanded')
            throw new Error(`The running work summary did not stay expanded (${outcome})`);
    } finally {
        await rm(holdPath, { force: true });
        await fixture.stop();
    }
}
