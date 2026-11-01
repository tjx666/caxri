import type { AgentChatSnapshot } from '@caxri/protocol';
import { draculaTheme } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { adbShell, mobileColorBounds, tapMobileCheck, waitForMobile } from './mobile-android';

const PROMPT = 'Run the related checks';
const NARRATION = 'All checks pass. Running the related tests once more.';

/**
 * A command without a description titles its row with the command itself, so a long one is the widest title a work
 * summary can carry.
 */
const LONG_COMMAND =
    "cd /tmp/caxri-fixture/worktrees/feature-branch-with-a-long-name; bunx vitest run --silent='passed-only' scripts/__tests__/logging-contract.test.ts; bun run --silent check --related";

/**
 * A turn whose work is a quick command followed by a long one that keeps running, so the phone shows a two-call summary
 * titled with that long command.
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
                    input: { command: 'git status --short' },
                    output: '',
                    durationMs: 100,
                },
                {
                    kind: 'tool',
                    name: 'Bash',
                    input: { command: LONG_COMMAND },
                    output: 'done',
                    durationMs: 900_000,
                },
            ],
        },
    ],
};

const hasRunningSecondCommand = (snapshot: AgentChatSnapshot): boolean => {
    const commands = snapshot.items.filter((item) => item.type === 'command');
    return (
        Boolean(snapshot.activeTurnId) &&
        commands.length === 2 &&
        commands.at(-1)?.status === 'running'
    );
};

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
 * `MOB-CHAT-WORK-GROUP-TITLE-01` (#3380): expanding a running summary titled with a long command used to lift the
 * title's one-line limit, so the whole command wrapped over several lines above a row repeating it. Expanded, the
 * summary now keeps one line as Desktop's does, so the card grows only by its rows: about two more header heights for
 * two calls, where the wrapped title added several more lines.
 */
export async function executeMobileChatWorkGroupTitleScenario(
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
        await waitForMobile(() => chat.read(), hasRunningSecondCommand, 60_000);
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
        await pause(1500);
        await capture(environment, 'expanded', artifacts);
        const expanded = await cardBounds(serial);
        const expandedHeight = expanded ? expanded.bottom - expanded.top : 0;
        // Two one-line rows add about two header heights; a wrapped title adds its extra lines on top of that.
        const outcome =
            expandedHeight <= collapsedHeight
                ? 'not-expanded'
                : expandedHeight - collapsedHeight <= collapsedHeight * 2.5
                  ? 'one-line-title'
                  : 'wrapped-title';
        await finish(environment, artifacts, {
            collapsedHeight,
            expandedHeight,
            outcome,
            status: outcome === 'one-line-title' ? 'passed' : 'failed',
        });
        if (outcome !== 'one-line-title')
            throw new Error(`The expanded summary did not keep a one-line title (${outcome})`);
    } finally {
        await fixture.stop();
    }
}
