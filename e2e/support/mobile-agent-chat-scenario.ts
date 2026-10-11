import type { AgentChatSnapshot, AppSettings } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    adbShell,
    androidBounds,
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
 * The on-screen height of check `id`, or `undefined` while it is not laid out.
 */
async function checkHeight(serial: string, id: string): Promise<number | undefined> {
    const node = (await mobileSemantics(serial)).find(({ checkId }) => checkId === id);
    const bounds = node && androidBounds(node.bounds);
    return bounds ? bounds.bottom - bounds.top : undefined;
}

/**
 * Taps the approval text's Show all / Show less toggle and waits until the text grows or shrinks past `height`.
 */
async function toggleApprovalText(
    serial: string,
    id: string,
    height: number,
    direction: 'grow' | 'shrink',
): Promise<number> {
    await tapMobileCheckByBounds(serial, `${id}-toggle`);
    const next = await waitForMobile(
        () => checkHeight(serial, id),
        (value) => value !== undefined && (direction === 'grow' ? value > height : value < height),
    );
    if (next === undefined) throw new Error(`${id} is no longer laid out`);
    return next;
}

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
async function executeMobileAgentChatScenario(
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
        // The phone cannot show thumbnails yet, so an image-only message from the desktop reads as its image count.
        await chat.send({
            text: '',
            images: [
                {
                    mediaType: 'image/png',
                    data: 'iVBORw0KGgo=',
                    thumbnail: 'data:image/jpeg;base64,/9j/4AAQ',
                },
            ],
        });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('Received 1 image.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'image-message', artifacts);

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

/**
 * `MOB-CHAT-02`: a Claude Code Chat asks to approve a plan, a tool request that is neither a command nor a file edit,
 * and the phone shows the tool name and plan, expands the plan past its clamp to read it whole, and accepts it.
 */
async function executeMobileClaudeToolApprovalScenario(
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
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');

        await sendFromPhone(serial, 'planmode');
        await waitForCheck(serial, 'agent-chat-request-tool');
        await waitForCheck(serial, 'agent-chat-approval-accept');
        // The eight-step plan runs past the six-line clamp, so the card offers Show all.
        await waitForCheck(serial, 'agent-chat-request-tool-toggle');
        const clamped = await checkHeight(serial, 'agent-chat-request-tool');
        if (clamped === undefined) throw new Error('The plan is not laid out');
        await capture(environment, 'tool-approval', artifacts);
        const expanded = await toggleApprovalText(
            serial,
            'agent-chat-request-tool',
            clamped,
            'grow',
        );
        await capture(environment, 'tool-approval-expanded', artifacts);
        await toggleApprovalText(serial, 'agent-chat-request-tool', expanded, 'shrink');
        await tapMobileCheckByBounds(serial, 'agent-chat-approval-accept');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('Plan approved.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');
        await capture(environment, 'tool-approved', artifacts);

        await finish(environment, artifacts, { approval: 'accepted', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-03`: the phone starts a new Session as a Codex Chat. `Open as` follows the Mac's `Open Agents in Chat`
 * setting, hides for Shell, and the created Session opens the streamed Agent Chat view on a `chat` Terminal.
 */
async function executeMobileNewChatSessionScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const { page } = fixture.running;
        const current = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
        await pageRequest(page, 'settings.update', {
            source: JSON.stringify({ ...current.value, 'session.openAgentsInChat': true }, null, 2),
        });
        await fixture.pair();
        const before = await pageRequest<{ sessions: Array<{ id: string }> }>(
            page,
            'app.bootstrap',
        );

        await tapMobileCheck(serial, 'new-session-button');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'new-session-agent-codex' && enabled,
                ) && hasCheck(nodes, `new-session-project-${fixture.allowedProjectId}`),
        );
        await tapMobileCheck(serial, `new-session-project-${fixture.allowedProjectId}`);
        await tapMobileCheck(serial, 'new-session-agent-shell');
        await waitForNoCheck(serial, 'new-session-surface-chat');
        await capture(environment, 'shell-no-surface', artifacts);

        await tapMobileCheck(serial, 'new-session-agent-codex');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, selected }) => checkId === 'new-session-surface-chat' && selected,
                ) &&
                nodes.some(
                    ({ checkId, selected }) =>
                        checkId === 'new-session-surface-terminal' && !selected,
                ),
        );
        await capture(environment, 'chat-default', artifacts);

        await tapMobileCheck(serial, 'new-session-create');
        await waitForCheck(serial, 'agent-chat');
        await waitForCheck(serial, 'agent-chat-status-empty');
        const after = await pageRequest<{
            sessions: Array<{ id: string }>;
            terminals: Array<{ id: string; kind: string; sessionId: string; surface: string }>;
        }>(page, 'app.bootstrap');
        const knownSessionIds = new Set(before.sessions.map(({ id }) => id));
        const created = after.sessions.find(({ id }) => !knownSessionIds.has(id));
        const terminal = after.terminals.find(({ sessionId }) => sessionId === created?.id);
        if (terminal?.kind !== 'codex' || terminal.surface !== 'chat')
            throw new Error('The phone did not create a Codex Chat Terminal');
        await capture(environment, 'created', artifacts);

        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () =>
                pageRequest<AgentChatSnapshot>(page, 'agentChat.read', {
                    terminalId: terminal.id,
                }),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'reply', artifacts);

        await finish(environment, artifacts, {
            defaultSurface: 'chat',
            shellSurface: 'hidden',
            createdSurface: 'chat',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * Runs the Agent Chat Acceptance case `environment.caseId` names.
 */
export async function executeMobileAgentChatCase(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    if (environment.caseId === 'MOB-CHAT-03') {
        await executeMobileNewChatSessionScenario(environment, artifacts);
        return;
    }
    await (environment.caseId === 'MOB-CHAT-02'
        ? executeMobileClaudeToolApprovalScenario(environment, artifacts)
        : executeMobileAgentChatScenario(environment, artifacts));
}
