import type { AgentChatSnapshot } from '@caxri/protocol';

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
 * Opens the model sheet from the composer row and waits until it is on screen.
 */
async function openModelSheet(serial: string): Promise<void> {
    await tapMobileCheckByBounds(serial, 'agent-chat-model-button');
    await waitForCheck(serial, 'agent-chat-model-sheet');
}

/**
 * Waits until the sheet marks exactly `checkIds` as the checked options, so the phone's own display is proven and not
 * only the Server's projection.
 */
async function waitForCheckedOptions(serial: string, checkIds: string[]): Promise<void> {
    const expected = checkIds.toSorted((left, right) => left.localeCompare(right)).join(',');
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes
                .filter(
                    ({ checked, checkId }) =>
                        checked && /^agent-chat-(?:model|effort)-[a-z]/u.test(checkId),
                )
                .map(({ checkId }) => checkId)
                .toSorted((left, right) => left.localeCompare(right))
                .join(',') === expected,
    );
}

/**
 * `MOB-CHAT-04`: a phone chooses the model and effort of a new Codex Chat before its first message, changes them again
 * between turns and while a turn runs (the sheet says the change applies from the next turn, and the next turn keeps
 * it), and sees the sheet disabled with its reason when the connection drops. Each choice is proven on the phone's
 * checked options and against the Server's Chat projection, which Desktop's menu reads.
 */
async function executeMobileChatModelScenario(
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
        const waitForChoice = async (model: string, effort: string): Promise<void> => {
            await waitForMobile(
                () => chat.read(),
                (snapshot) => snapshot.model === model && snapshot.effort === effort,
            );
            await waitForCheckedOptions(serial, [
                `agent-chat-model-${model}`,
                `agent-chat-effort-${effort}`,
            ]);
        };
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await waitForCheck(serial, 'agent-chat-model-button');
        await capture(environment, 'new-chat-model-row', artifacts);

        // 1. Before the first message.
        await openModelSheet(serial);
        await capture(environment, 'model-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-fake-codex-mini');
        // The smaller model accepts only `low`, so the effort falls back with the switch.
        await waitForChoice('fake-codex-mini', 'low');
        await capture(environment, 'mini-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-fake-codex-model');
        await waitForCheck(serial, 'agent-chat-effort-high');
        await tapMobileCheckByBounds(serial, 'agent-chat-effort-high');
        await waitForChoice('fake-codex-model', 'high');
        await capture(environment, 'model-switched-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        if ((await chat.read()).effort !== 'high')
            throw new Error('The first turn lost the chosen effort');
        await capture(environment, 'first-turn', artifacts);

        // 2. Mid-session: between turns, then while a turn runs.
        await openModelSheet(serial);
        await tapMobileCheckByBounds(serial, 'agent-chat-effort-medium');
        await waitForChoice('fake-codex-model', 'medium');
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        await sendFromPhone(serial, 'slow');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => Boolean(snapshot.activeTurnId),
        );
        await openModelSheet(serial);
        await waitForCheck(serial, 'agent-chat-model-note');
        await tapMobileCheckByBounds(serial, 'agent-chat-model-fake-codex-mini');
        await waitForChoice('fake-codex-mini', 'low');
        await capture(environment, 'running-turn-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        // The switch must not cut the running turn short.
        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && snapshot.status !== 'failed',
            60_000,
        );
        await sendFromPhone(serial, 'again');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: again') && !snapshot.activeTurnId,
        );
        const next = await chat.read();
        if (next.model !== 'fake-codex-mini' || next.effort !== 'low')
            throw new Error('The next turn did not keep the choice made during the running turn');
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'next-turn', artifacts);

        // 3. Offline.
        await openModelSheet(serial);
        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await waitForCheck(serial, 'agent-chat-model-disabled-reason', 60_000);
        const options = await mobileSemantics(serial);
        if (
            options.some(
                ({ checkId, enabled }) =>
                    enabled &&
                    /^agent-chat-(?:model|effort)-fake|^agent-chat-effort-low$/u.test(checkId),
            )
        )
            throw new Error('An option stayed enabled while offline');
        await capture(environment, 'offline-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForCheck(serial, 'agent-chat-model-label');
        await capture(environment, 'offline-row', artifacts);
        await setMobileNetworkAvailable(serial, true);
        isNetworkDisabled = false;
        await waitForCheck(serial, 'agent-chat-model-button', 60_000);
        await openModelSheet(serial);
        await waitForChoice('fake-codex-mini', 'low');
        await capture(environment, 'reconnected-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');

        await finish(environment, artifacts, {
            firstTurn: 'configured-before-send',
            midSession: 'configured-between-and-during-turns',
            offline: 'disabled-with-reason',
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
 * Runs the Agent Chat Acceptance case `environment.caseId` names.
 */
export async function executeMobileAgentChatCase(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-CHAT-01':
            return executeMobileAgentChatScenario(environment, artifacts);
        case 'MOB-CHAT-02':
            return executeMobileClaudeToolApprovalScenario(environment, artifacts);
        case 'MOB-CHAT-04':
            return executeMobileChatModelScenario(environment, artifacts);
        default:
            throw new Error(`Unsupported Agent Chat Acceptance case: ${environment.caseId}`);
    }
}
