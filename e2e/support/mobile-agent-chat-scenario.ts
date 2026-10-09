import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    adbShell,
    mobileSemantics,
    observeMobileNode,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const hasCheck = (nodes: Array<{ checkId: string }>, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

const waitForCheck = (serial: string, id: string, timeoutMs = 30_000) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => hasCheck(nodes, id),
        timeoutMs,
    );

const waitForNoCheck = (serial: string, id: string, timeoutMs = 30_000) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => !hasCheck(nodes, id),
        timeoutMs,
    );

const agentText = (snapshot: AgentChatSnapshot): string =>
    snapshot.items
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text)
        .join('\n');

/**
 * Sends one keyword message from the phone. The fake app-server picks its behavior from the keyword, and a single ASCII
 * word survives `input text` without the fixture IME.
 */
async function sendFromPhone(serial: string, word: string): Promise<void> {
    await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
    await adbShell(serial, ['input', 'text', word]);
    const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'equals',
        value: word,
    });
    if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
    await tapMobileCheck(serial, 'agent-chat-composer-send');
}

/**
 * `MOB-CHAT-01`: a phone reads and drives a Codex Chat end to end. Each phone action is proven against the Server's own
 * Chat projection, and the screenshots cover the empty, streamed, approval, question, failed, and offline states.
 */
export async function executeMobileAgentChatScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let isNetworkDisabled = false;
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat');
        const tabs = await mobileSemantics(serial);
        if (hasCheck(tabs, 'session-segment-terminal'))
            throw new Error('A Chat must not offer a Terminal tab');
        await waitForCheck(serial, 'agent-chat-status-empty');
        await capture(environment, 'empty', artifacts);

        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await sendFromPhone(serial, 'table');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('| Option | Cost |') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'conversation', artifacts);

        await sendFromPhone(serial, 'approve');
        await waitForCheck(serial, 'agent-chat-approval-accept');
        await capture(environment, 'approval', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-approval-accept');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('The command ran.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');

        await sendFromPhone(serial, 'ask');
        await waitForCheck(serial, 'agent-chat-question-0-option-1');
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-1');
        await capture(environment, 'question', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-question-submit');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You chose Blue.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');

        await sendFromPhone(serial, 'crash');
        await waitForCheck(serial, 'agent-chat-failed-action');
        await capture(environment, 'failed', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-failed-action');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.status === 'ready',
        );
        await waitForNoCheck(serial, 'agent-chat-failed');

        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await waitForCheck(serial, 'connection-stale-banner', 60_000);
        const offline = await mobileSemantics(serial);
        if (!hasCheck(offline, 'agent-chat') || hasCheck(offline, 'agent-chat-stale'))
            throw new Error(
                'An offline Chat must keep its last copy under the one connection banner',
            );
        await capture(environment, 'offline', artifacts);
        await setMobileNetworkAvailable(serial, true);
        isNetworkDisabled = false;
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);

        await finish(environment, artifacts, {
            approval: 'accepted',
            question: 'answered',
            retry: 'resumed',
            status: 'passed',
        });
    } finally {
        if (isNetworkDisabled) {
            try {
                await setMobileNetworkAvailable(serial, true);
            } catch {
                // Teardown must still stop the fixture; the scenario's own failure is the useful error.
            }
        }
        await fixture.stop();
    }
}
