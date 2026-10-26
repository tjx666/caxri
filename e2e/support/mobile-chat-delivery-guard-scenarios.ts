import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentUsageReadout } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    sendFromPhone,
    typeChatDraft,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    observeMobileNode,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

/**
 * How long a Chat session keeps one `/usage` answer (`CLAUDE_PLAN_LIMITS_REFRESH_MS`) plus slack, which bounds how soon
 * a changed fake plan reading reaches the usage guard.
 */
const PLAN_READING_WAIT_MS = 120_000;

/**
 * `MOB-CHAT-SEND-UNKNOWN-01` (#1917): the Acceptance build's `chat-send-unknown-once` fault lets the first phone send
 * reach Server Core and then fails it as a dropped connection would. The Chat shows `Couldn't confirm delivery`, not
 * `not sent`, keeps the draft in the composer, and the message is in the Chat, so the notice was right to warn.
 */
export async function executeMobileChatSendUnknownScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        if (environment.remoteVideoPath)
            recording = await startMobileFramebufferRecording(serial, environment.remoteVideoPath);
        const word = 'hello';
        await sendFromPhone(serial, word);

        await waitForCheck(serial, 'agent-chat-composer-error', 60_000);
        const notice = await observeMobileNode(serial, 'agent-chat-composer-error', {
            kind: 'includes',
            value: "Couldn't confirm delivery. Check the Chat before sending again.",
        });
        if (!notice.exists || !notice.textMatches)
            throw new Error('The unknown-delivery notice is unavailable');
        const refused = await observeMobileNode(serial, 'agent-chat-composer-error', {
            kind: 'includes',
            value: 'not sent',
        });
        if (refused.textMatches) throw new Error('The unknown outcome was worded as not sent');
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: word,
        });
        if (!draft.exists || !draft.textMatches)
            throw new Error('The unknown-delivery send did not keep the draft');
        await capture(environment, 'delivery-unknown', artifacts);

        // The request really reached Server Core: the message is in the Chat although the phone could not confirm it.
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.items.some((item) => item.type === 'userMessage' && item.text === word),
            60_000,
        );
        await capture(environment, 'message-in-chat', artifacts);
        await finish(environment, artifacts, {
            draft: 'retained',
            notice: 'delivery-unconfirmed',
            serverReceived: 'message-in-chat',
            status: 'passed',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-USAGE-GUARD-01` (#2609): a Claude account whose weekly usage reaches 99% shows the phone's Chat a banner
 * with the reset time and disables Send; once the guard's window ends, the banner leaves and Send works again. The fake
 * Claude's `/usage` answer is steered through a control file, so the Server arms and lifts the guard from its own
 * plan-limit readings, the way a real account does.
 */
export async function executeMobileChatUsageGuardScenario(
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
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // A running Chat is the only thing that answers `/usage`, so start one before the guard.
        await chat.send({ text: 'hi there' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        const guardFile = join(fixture.testDirectory, 'plan-weekly-guarded');
        /**
         * Each read asks the Server to refresh the plan reading, which arms or lifts the guard from the fake's answer.
         */
        const readGuard = async () => {
            await pageRequest<AgentUsageReadout | null>(
                fixture.running.page,
                'terminal.agentUsage',
                {
                    terminalId: chat.terminalId,
                },
            );
            return (await chat.read()).usageGuard;
        };
        await writeFile(guardFile, '');
        const armed = await waitForMobile(
            readGuard,
            (guard) => guard !== undefined,
            PLAN_READING_WAIT_MS,
        );
        if (!armed || armed.usedPercent < 99)
            throw new Error('The weekly guard did not arm at 99%');

        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-usage-guard');
        await capture(environment, 'guard-banner', artifacts);
        await typeChatDraft(serial, 'one more thing');
        await waitForCheck(serial, 'agent-chat-composer-reason');
        const guarded = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === 'agent-chat-composer-send',
        );
        if (!guarded || guarded.enabled) throw new Error('Send stayed enabled under the guard');
        await capture(environment, 'guard-banner-send-disabled', artifacts);

        // The window ends: the next plan reading shows a later week below the guard, which lifts it.
        await rm(guardFile, { force: true });
        await waitForMobile(readGuard, (guard) => guard === undefined, PLAN_READING_WAIT_MS);
        await waitForNoCheck(serial, 'agent-chat-usage-guard');
        await waitForNoCheck(serial, 'agent-chat-composer-reason');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'agent-chat-composer-send' && enabled,
                ),
        );
        await capture(environment, 'guard-lifted-send-enabled', artifacts);
        await finish(environment, artifacts, {
            banner: 'shown-then-lifted',
            sendButton: 'disabled-then-enabled',
            status: 'passed',
            weeklyUsedPercent: Math.floor(armed.usedPercent),
        });
    } finally {
        await fixture.stop();
    }
}
