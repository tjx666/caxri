import type { BootstrapState, TerminalRecord } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

const FIRST_PROMPT = 'Summarize the repository layout';

/**
 * Opens the Session detail menu and taps its "Open as ..." entry.
 */
async function openAsOtherSurface(serial: string): Promise<void> {
    await tapMobileCheck(serial, 'session-detail-menu');
    await waitForCheck(serial, 'session-switch-surface');
    await tapMobileCheck(serial, 'session-switch-surface');
}

/**
 * `MOB-CHAT-SURFACE-SWITCH-01`: a control phone reopens a Codex Chat as a Terminal and back from the Session detail
 * menu, on the same thread, and lands on the tab that shows it. A switch during a running turn asks first: Cancel keeps
 * the Chat, and "Stop and Switch" reopens it as a Terminal.
 */
export async function executeMobileChatSurfaceSwitchScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        const agentTerminal = async (): Promise<TerminalRecord | undefined> => {
            const state = await pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap');
            return state.terminals.find((terminal) => terminal.sessionId === sessionId);
        };
        await chat.send({ text: FIRST_PROMPT });
        const bound = await waitForMobile(
            async () => ({ snapshot: await chat.read(), terminal: await agentTerminal() }),
            ({ snapshot, terminal }) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage') &&
                Boolean(terminal?.agentSessionId),
        );
        const thread = bound.terminal?.agentSessionId;
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat');

        await tapMobileCheck(serial, 'session-detail-menu');
        await waitForCheck(serial, 'session-switch-surface');
        await capture(environment, 'menu-open-as-terminal', artifacts);
        await tapMobileCheck(serial, 'session-switch-surface');
        await waitForMobile(agentTerminal, (terminal) => terminal?.surface !== 'chat', 60_000);
        await waitForCheck(serial, 'terminal-live-view', 60_000);
        await waitForNoCheck(serial, 'agent-chat');
        await capture(environment, 'terminal', artifacts);
        if ((await agentTerminal())?.agentSessionId !== thread)
            throw new Error('The Terminal must continue the Chat thread');

        await tapMobileCheck(serial, 'session-detail-menu');
        await waitForCheck(serial, 'session-switch-surface');
        await capture(environment, 'menu-open-as-chat', artifacts);
        await tapMobileCheck(serial, 'session-switch-surface');
        await waitForMobile(agentTerminal, (terminal) => terminal?.surface === 'chat', 60_000);
        await waitForCheck(serial, 'agent-chat', 60_000);
        const resumed = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.items.some(
                    (item) => item.type === 'userMessage' && item.text === FIRST_PROMPT,
                ),
        );
        await capture(environment, 'chat-again', artifacts);
        if ((await agentTerminal())?.agentSessionId !== thread)
            throw new Error('The Chat must resume the same thread');

        // `approve` waits on an approval, so the turn is still running when the phone asks to switch.
        await chat.send({ text: 'approve' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => Boolean(snapshot.activeTurnId),
        );
        await openAsOtherSurface(serial);
        await waitForCheck(serial, 'session-switch-surface-confirm');
        await capture(environment, 'running-turn-confirm', artifacts);
        await tapMobileCheck(serial, 'session-switch-surface-confirm-cancel');
        await waitForNoCheck(serial, 'session-switch-surface-confirm');
        await waitForCheck(serial, 'agent-chat');
        if ((await agentTerminal())?.surface !== 'chat')
            throw new Error('Cancel must keep the Chat');

        await openAsOtherSurface(serial);
        await waitForCheck(serial, 'session-switch-surface-confirm');
        await tapMobileCheck(serial, 'session-switch-surface-confirm-confirm');
        await waitForMobile(agentTerminal, (terminal) => terminal?.surface !== 'chat', 60_000);
        await waitForCheck(serial, 'terminal-live-view', 60_000);
        await capture(environment, 'terminal-after-stop', artifacts);

        await finish(environment, artifacts, {
            cancel: 'kept-chat',
            chatItems: resumed.items.length,
            runningTurn: 'stopped-and-switched',
            sameThread: true,
            status: 'passed',
            switches: ['chat-to-terminal', 'terminal-to-chat', 'chat-to-terminal'],
        });
    } finally {
        await fixture.stop();
    }
}
