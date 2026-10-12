import type { AgentChatSnapshot } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    hasCheck,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

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
export async function executeMobileChatModelScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let isNetworkDisabled = false;
    try {
        const { page } = fixture.running;
        await fixture.pair();
        const before = await pageRequest<{ sessions: Array<{ id: string }> }>(
            page,
            'app.bootstrap',
        );
        // The phone creates the Chat itself, so the first choice is made on a brand-new Session.
        await tapMobileCheck(serial, 'new-session-button');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'new-session-agent-codex' && enabled,
                ) && hasCheck(nodes, `new-session-project-${fixture.allowedProjectId}`),
        );
        await tapMobileCheck(serial, `new-session-project-${fixture.allowedProjectId}`);
        await tapMobileCheck(serial, 'new-session-agent-codex');
        await waitForCheck(serial, 'new-session-surface-chat');
        await tapMobileCheck(serial, 'new-session-surface-chat');
        await tapMobileCheck(serial, 'new-session-create');
        await waitForCheck(serial, 'agent-chat-status-empty');
        const after = await pageRequest<{
            sessions: Array<{ id: string }>;
            terminals: Array<{ id: string; sessionId: string; surface: string }>;
        }>(page, 'app.bootstrap');
        const knownSessionIds = new Set(before.sessions.map(({ id }) => id));
        const created = after.sessions.find(({ id }) => !knownSessionIds.has(id));
        const terminal = after.terminals.find(({ sessionId }) => sessionId === created?.id);
        if (terminal?.surface !== 'chat') throw new Error('The phone did not create a Chat');
        const chat = {
            read: () =>
                pageRequest<AgentChatSnapshot>(page, 'agentChat.read', {
                    terminalId: terminal.id,
                }),
        };
        /**
         * The Server's choice after each step, kept in the scenario receipt so the review can compare it with the
         * phone's checked options in the matching screenshot.
         */
        const steps: Array<{ step: string; model?: string; effort?: string }> = [];
        const waitForChoice = async (
            step: string,
            model: string,
            effort: string,
        ): Promise<void> => {
            const snapshot = await waitForMobile(
                () => chat.read(),
                (current) => current.model === model && current.effort === effort,
            );
            await waitForCheckedOptions(serial, [
                `agent-chat-model-${model}`,
                `agent-chat-effort-${effort}`,
            ]);
            steps.push({ step, model: snapshot.model, effort: snapshot.effort });
        };
        await waitForCheck(serial, 'agent-chat-model-button');
        await capture(environment, 'new-chat-model-row', artifacts);

        // 1. Before the first message.
        await openModelSheet(serial);
        await capture(environment, 'model-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-fake-codex-mini');
        // The smaller model accepts only `low`, so the effort falls back with the switch.
        await waitForChoice('mini', 'fake-codex-mini', 'low');
        await capture(environment, 'mini-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-fake-codex-model');
        await waitForCheck(serial, 'agent-chat-effort-high');
        await tapMobileCheckByBounds(serial, 'agent-chat-effort-high');
        await waitForChoice('model-high', 'fake-codex-model', 'high');
        await capture(environment, 'model-switched-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        const first = await chat.read();
        if (first.effort !== 'high') throw new Error('The first turn lost the chosen effort');
        steps.push({ step: 'after-first-turn', model: first.model, effort: first.effort });
        await capture(environment, 'first-turn', artifacts);

        // 2. Mid-session: between turns, then while a turn runs.
        await openModelSheet(serial);
        await tapMobileCheckByBounds(serial, 'agent-chat-effort-medium');
        await waitForChoice('idle-medium', 'fake-codex-model', 'medium');
        await capture(environment, 'idle-medium-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        /**
         * A turn waiting on a question stays running while the screen holds still; a streaming turn never lets
         * UIAutomator read the screen, so it cannot drive the sheet. A command approval would show the fixture's
         * working directory, which evidence must not capture.
         */
        await sendFromPhone(serial, 'ask');
        await waitForCheck(serial, 'agent-chat-question-0-option-1');
        await openModelSheet(serial);
        await waitForCheck(serial, 'agent-chat-model-note');
        await tapMobileCheckByBounds(serial, 'agent-chat-model-fake-codex-mini');
        await waitForChoice('running-turn-mini', 'fake-codex-mini', 'low');
        await capture(environment, 'running-turn-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        // The switch must not cut the running turn short: it still finishes once answered with one tap.
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-1');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You chose Blue.') && !snapshot.activeTurnId,
        );
        await sendFromPhone(serial, 'again');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: again') && !snapshot.activeTurnId,
        );
        const next = await chat.read();
        if (next.model !== 'fake-codex-mini' || next.effort !== 'low')
            throw new Error('The next turn did not keep the choice made during the running turn');
        steps.push({ step: 'after-next-turn', model: next.model, effort: next.effort });
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'next-turn', artifacts);

        // 3. Offline.
        await openModelSheet(serial);
        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await waitForCheck(serial, 'agent-chat-model-disabled-reason', 60_000);
        const options = (await mobileSemantics(serial)).filter(({ checkId }) =>
            /^agent-chat-(?:model-fake|effort-)/u.test(checkId),
        );
        const offlineOptions = {
            enabled: options.filter(({ enabled }) => enabled).length,
            total: options.length,
        };
        if (offlineOptions.total === 0 || offlineOptions.enabled > 0)
            throw new Error('An option stayed enabled while offline');
        await capture(environment, 'offline-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForCheck(serial, 'agent-chat-model-label');
        await capture(environment, 'offline-row', artifacts);
        await setMobileNetworkAvailable(serial, true);
        isNetworkDisabled = false;
        await waitForCheck(serial, 'agent-chat-model-button', 60_000);
        await openModelSheet(serial);
        await waitForChoice('reconnected', 'fake-codex-mini', 'low');
        await capture(environment, 'reconnected-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');

        await finish(environment, artifacts, {
            firstTurn: 'configured-before-send',
            midSession: 'configured-between-and-during-turns',
            offline: 'disabled-with-reason',
            offlineOptions,
            status: 'passed',
            steps,
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
