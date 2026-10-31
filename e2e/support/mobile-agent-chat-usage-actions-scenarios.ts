import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    observeMobileNode,
    setMobileNetworkAvailable,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

type Fixture = Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;

/**
 * Sends `prompt` from the Mac, so the phone opens a Chat that already reached its usage state, then opens that Chat on
 * the paired phone.
 */
async function openChatAfter(fixture: Fixture, serial: string, prompt: string) {
    const chat = fixture.agentChat;
    if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
    await chat.send({ text: prompt });
    await waitForMobile(
        () => chat.read(),
        (snapshot) => !snapshot.activeTurnId,
    );
    await fixture.pair();
    await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
    return chat;
}

/**
 * Fails unless the control `id` reads `text`, the name Desktop gives the same action.
 */
async function expectText(serial: string, id: string, text: string): Promise<void> {
    const node = await observeMobileNode(serial, id, { kind: 'includes', value: text });
    if (!node.exists || !node.textMatches) throw new Error(`${id} does not read "${text}"`);
}

/**
 * `MOB-CHAT-USAGE-ACT-01` (#2939): a Claude Chat that used up its 5-hour limit waits to continue; its card on the phone
 * offers Continue now and Cancel, and Continue now runs the continuation turn at once, after which the card has no
 * actions left.
 */
export async function executeMobileChatUsageLimitContinueScenario(
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
        // The fake Claude answers this prompt with a rejected 5-hour limit, so the Chat waits for the reset.
        const chat = await openChatAfter(fixture, serial, 'usage exhausted');
        await waitForCheck(serial, 'chat-usage-limit-continueNow', 60_000);
        await waitForCheck(serial, 'chat-usage-limit-cancel');
        await expectText(serial, 'chat-usage-limit-continueNow', 'Continue now');
        await expectText(serial, 'chat-usage-limit-cancel', 'Cancel');
        await capture(environment, 'waiting', artifacts);
        // The fake's limit resets in 2 hours, so a reply within this case can only come from Continue now.
        const tappedAt = Date.now();

        await tapMobileCheck(serial, 'chat-usage-limit-continueNow');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId && agentText(snapshot).includes('Hello from fake Claude'),
            60_000,
        );
        await waitForNoCheck(serial, 'chat-usage-limit-continueNow');
        await waitForNoCheck(serial, 'chat-usage-limit-cancel');
        await capture(environment, 'continued', artifacts);
        await finish(environment, artifacts, {
            actions: 'continue-now-then-none',
            continuation: 'answered',
            continuationSeconds: Math.round((Date.now() - tappedAt) / 1000),
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-USAGE-ACT-02` (#2939): a Claude Chat at 99% of its weekly usage shows the guard card on the phone; Generate
 * hand-off shows the document being written, then the document with Copy, and the hand-off is spent. Continue anyway
 * then lifts the guard. The fake holds the side question behind a control file so the writing state stays on screen.
 */
export async function executeMobileChatUsageGuardHandoffScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const hold = join(fixture.testDirectory, 'hold-side-question');
    try {
        // The fake Claude reports the weekly window at 99.5% before it answers, which arms the guard.
        const chat = await openChatAfter(fixture, serial, 'weekly nearly used');
        await waitForCheck(serial, 'agent-chat-usage-guard-generateHandoff', 60_000);
        await waitForCheck(serial, 'agent-chat-usage-guard-bypassUsageGuard');
        await expectText(serial, 'agent-chat-usage-guard-generateHandoff', 'Generate hand-off');
        await expectText(serial, 'agent-chat-usage-guard-bypassUsageGuard', 'Continue anyway');
        await capture(environment, 'guard', artifacts);

        await writeFile(hold, '');
        await tapMobileCheck(serial, 'agent-chat-usage-guard-generateHandoff');
        await waitForCheck(serial, 'agent-chat-usage-guard-generating', 60_000);
        // Held by the fake, so the document cannot have arrived yet.
        if (
            (await mobileSemantics(serial)).some(
                ({ checkId }) => checkId === 'agent-chat-usage-guard-document',
            )
        )
            throw new Error('The hand-off arrived while the fake still held it');
        await capture(environment, 'generating', artifacts);

        await rm(hold, { force: true });
        await waitForCheck(serial, 'agent-chat-usage-guard-document', 60_000);
        await waitForCheck(serial, 'agent-chat-usage-guard-copy');
        await waitForNoCheck(serial, 'agent-chat-usage-guard-generating');
        // The account's one hand-off this week is spent.
        await waitForNoCheck(serial, 'agent-chat-usage-guard-generateHandoff');
        await capture(environment, 'generated', artifacts);

        await tapMobileCheck(serial, 'agent-chat-usage-guard-bypassUsageGuard');
        await waitForNoCheck(serial, 'agent-chat-usage-guard', 60_000);
        // The guard really let requests through: a new message gets its answer, and the guard stays lifted.
        await chat.send({ text: 'one more thing' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId && agentText(snapshot).includes('Hello from fake Claude'),
            60_000,
        );
        await waitForNoCheck(serial, 'agent-chat-usage-guard');
        await capture(environment, 'continued-anyway', artifacts);
        await finish(environment, artifacts, {
            guard: 'lifted-by-continue-anyway',
            nextTurn: 'answered',
            handoff: 'generating-then-generated',
            status: 'passed',
        });
    } finally {
        await rm(hold, { force: true });
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-USAGE-ACT-03` (#2939): offline, the guard card's buttons are disabled and the reason sits beneath them;
 * back online they work again.
 */
export async function executeMobileChatUsageGuardOfflineScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    let isNetworkDisabled = false;
    try {
        await openChatAfter(fixture, serial, 'weekly nearly used');
        await waitForCheck(serial, 'agent-chat-usage-guard-generateHandoff', 60_000);
        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await waitForCheck(serial, 'connection-stale-banner', 60_000);
        await waitForCheck(serial, 'agent-chat-usage-guard-blocked');
        await expectText(
            serial,
            'agent-chat-usage-guard-blocked',
            'Reconnect to act on usage limits.',
        );
        const offline = await mobileSemantics(serial);
        for (const id of [
            'agent-chat-usage-guard-generateHandoff',
            'agent-chat-usage-guard-bypassUsageGuard',
        ])
            if (offline.find(({ checkId }) => checkId === id)?.enabled !== false)
                throw new Error(`${id} stayed enabled offline`);
        await capture(environment, 'offline', artifacts);

        await setMobileNetworkAvailable(serial, true);
        isNetworkDisabled = false;
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
        await waitForNoCheck(serial, 'agent-chat-usage-guard-blocked');
        const online = await mobileSemantics(serial);
        if (
            !online.find(({ checkId }) => checkId === 'agent-chat-usage-guard-generateHandoff')
                ?.enabled
        )
            throw new Error('Generate hand-off stayed disabled back online');
        await capture(environment, 'online', artifacts);
        await finish(environment, artifacts, {
            buttons: 'disabled-offline-then-enabled',
            reason: 'shown-offline',
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
