import type { AgentChatSnapshot } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, withVisibleKeyboard } from './mobile-agent-chat-helpers';
import {
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * How the folded row names the two running shells in the case's `zh-CN` locale (`chat.tasks.backgroundWork`).
 */
const BACKGROUND_SEGMENT = '后台工作 2';

const runningShells = (snapshot: AgentChatSnapshot): number =>
    (snapshot.tasks ?? []).filter((task) => task.kind === 'shell' && task.status === 'running')
        .length;

/**
 * `MOB-CHAT-DOCK-FOLD-01`: a Claude Code Chat pursuing a goal with two background shells running. With the keyboard
 * down the goal bar and the `2 Background work` badge stack above the composer; with the keyboard up they fold into one
 * summary row that names the background work, so its count never reads as a count of goals.
 *
 * The fake's goal query streams for about 30 seconds and then ends with the goal still set (`fake-claude-goal.ts`), so
 * the captures wait for a still screen.
 */
export async function executeMobileChatDockFoldScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        chatProvider: 'claude',
        serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        for (let shell = 1; shell <= 2; shell += 1) {
            // eslint-disable-next-line no-await-in-loop -- each shell starts in its own turn
            await chat.send({ text: 'background' });
            // eslint-disable-next-line no-await-in-loop -- the next turn waits for this one to end
            await waitForMobile(
                () => chat.read(),
                (snapshot) => !snapshot.activeTurnId && runningShells(snapshot) === shell,
            );
        }
        await chat.runCommand({
            name: AGENT_CHAT_GOAL_COMMAND,
            arguments: 'every emulator check passes',
        });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.goal?.status === 'active' && !snapshot.activeTurnId,
            90_000,
        );

        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-goal');
        await capture(environment, 'keyboard-down', artifacts);

        // The fixture IME draws no keyboard and reports none to the app, so the emulator's own keyboard folds the dock.
        const folded = { isNamed: false };
        await withVisibleKeyboard(serial, async () => {
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
            await waitForCheck(serial, 'agent-chat-dock-summary');
            await capture(environment, 'keyboard-up', artifacts);
            const line = await observeMobileNode(serial, 'agent-chat-dock-summary-text', {
                kind: 'includes',
                value: BACKGROUND_SEGMENT,
            });
            folded.isNamed = line.exists && line.textMatches === true;
        });
        if (!folded.isNamed) {
            // Keep the captures citable in the failed round before failing it.
            await finish(environment, artifacts, { folded: 'unnamed', status: 'failed' });
            throw new Error(`The folded dock does not read "${BACKGROUND_SEGMENT}"`);
        }

        await finish(environment, artifacts, { folded: 'summary', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}
