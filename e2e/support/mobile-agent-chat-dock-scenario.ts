import type { AgentChatSnapshot } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    checkBounds,
    hasCheck,
    waitForCheck,
    withVisibleKeyboard,
} from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const runningShells = (snapshot: AgentChatSnapshot): number =>
    (snapshot.tasks ?? []).filter((task) => task.kind === 'shell' && task.status === 'running')
        .length;

/**
 * `MOB-CHAT-DOCK-FOLD-01`: a Claude Code Chat pursuing a goal with two background shells running. With the keyboard
 * down the goal bar and the `2 Background work` row stack above the composer, and with the keyboard up they stay as
 * they are: background work does not count toward folding, so no summary row replaces the goal bar.
 *
 * The fake's goal query streams for minutes (`fake-claude-goal.ts`), so the scenario interrupts it once the goal is
 * set; like real Claude Code, the interrupt keeps the goal and the background shells.
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
            (snapshot) => snapshot.goal?.status === 'active' && snapshot.activeTurnId !== undefined,
        );
        // An interrupted turn keeps the goal active and the shells running, and leaves a still screen to capture.
        await chat.interrupt();
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.goal?.status === 'active' &&
                !snapshot.activeTurnId &&
                runningShells(snapshot) === 2,
        );

        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-goal');
        await capture(environment, 'keyboard-down', artifacts);
        const composerDown = checkBounds(
            await mobileSemantics(serial),
            'agent-chat-composer-input',
        );
        if (!composerDown) throw new Error('The composer is not laid out');

        // The fixture IME draws no keyboard and reports none to the app, so the emulator's own keyboard is the one up.
        const dock = { isUnfolded: false };
        await withVisibleKeyboard(serial, async () => {
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
            // Only the app's own keyboard layout lifts the composer, so a lifted composer proves the app saw the
            // keyboard; without it the summary's absence below would pass before the dock ever had a chance to fold.
            const nodes = await waitForMobile(
                () => mobileSemantics(serial),
                (current) => {
                    const composer = checkBounds(current, 'agent-chat-composer-input');
                    return composer !== undefined && composer.top < composerDown.top - 300;
                },
            );
            dock.isUnfolded =
                hasCheck(nodes, 'agent-chat-goal') &&
                hasCheck(nodes, 'agent-chat-tasks') &&
                !hasCheck(nodes, 'agent-chat-dock-summary');
            await capture(environment, 'keyboard-up', artifacts);
        });
        if (!dock.isUnfolded) {
            // Keep the captures citable in the failed round before failing it.
            await finish(environment, artifacts, { folded: 'summary', status: 'failed' });
            throw new Error(
                'The dock folded a goal with only background work while the keyboard was up',
            );
        }

        await finish(environment, artifacts, { folded: 'none', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}
