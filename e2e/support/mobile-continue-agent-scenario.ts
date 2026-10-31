import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentUsageReadout, AppSettings, BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * How long a Chat session keeps one `/usage` answer plus slack, as in the delivery guard scenarios.
 */
const PLAN_READING_WAIT_MS = 120_000;

/**
 * The new Session opens on its Chat, whose first message is the delegated hand-off card the source Chat never shows.
 */
const waitForHandoffCard = (serial: string) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => nodes.some(({ checkId }) => checkId.startsWith('agent-chat-delegated-')),
        60_000,
    );

const isEnabled = async (serial: string, id: string): Promise<boolean> => {
    const node = (await mobileSemantics(serial)).find(({ checkId }) => checkId === id);
    if (!node) throw new Error(`${id} is missing`);
    return node.enabled;
};

const sessionIds = async (page: Parameters<typeof pageRequest>[0]): Promise<string[]> =>
    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.map(({ id }) => id);

/**
 * Opens a continued Agent as a Chat, as the product default does. The E2E profile defaults to Terminal, where a Codex
 * child would need lifecycle hooks the fixture leaves off.
 */
const openAgentsInChat = async (page: Parameters<typeof pageRequest>[0]): Promise<void> => {
    const settings = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
    await pageRequest(page, 'settings.update', {
        source: JSON.stringify({ ...settings.value, 'session.openAgentsInChat': true }),
    });
};

/**
 * Picks Codex in the open sheet and returns the Session it created on the paired Desktop.
 */
const continueInCodex = async (
    serial: string,
    page: Parameters<typeof pageRequest>[0],
): Promise<string> => {
    const before = await sessionIds(page);
    await tapMobileCheckByBounds(serial, 'session-continue-codex');
    const createdId = (
        await waitForMobile(
            () => sessionIds(page),
            (ids) => ids.some((id) => !before.includes(id)),
            60_000,
        )
    ).find((id) => !before.includes(id));
    if (!createdId) throw new Error('Continue did not create a Session');
    await waitForNoCheck(serial, 'agent-chat-continue-sheet');
    await waitForHandoffCard(serial);
    return createdId;
};

/**
 * Pairs a Claude Chat whose turn the fake fails with a used-up 5-hour limit, and opens it on the phone at that card.
 */
const openUsageLimitedChat = async (environment: MobileAgentScenarioEnvironment) => {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const chat = fixture.agentChat;
    const sessionId = fixture.allowedSessionId;
    if (!chat || !sessionId) {
        await fixture.stop();
        throw new Error('Chat fixture is unavailable');
    }
    await openAgentsInChat(fixture.running.page);
    // The fake Claude answers this prompt with a rejected 5-hour limit.
    await chat.send({ text: 'usage exhausted' });
    await waitForMobile(
        () => chat.read(),
        (snapshot) => snapshot.items.some((item) => item.type === 'notice' && item.usageLimit),
    );
    await fixture.pair();
    await tapMobileCheck(serial, `session-row-${sessionId}`);
    await waitForCheck(serial, 'agent-chat-continue-in-agent');
    return { chat, fixture, sessionId };
};

/**
 * `MOB-CHAT-CONT-AGENT-USAGE-01` (#2940): the usage-limit card offers Continue in Another Agent; the sheet lists the
 * other Agents, and picking Codex creates the new Session on Desktop and opens it on the phone. Back on the source
 * Chat, the card links to where the work continued.
 */
export async function executeMobileContinueAgentScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { fixture, sessionId } = await openUsageLimitedChat(environment);
    try {
        const { page } = fixture.running;
        await capture(environment, 'usage-limit-card', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-continue-in-agent');
        await waitForCheck(serial, 'session-continue-codex');
        await capture(environment, 'continue-sheet', artifacts);

        const createdId = await continueInCodex(serial, page);
        await capture(environment, 'continued-session', artifacts);

        await tapMobileCheckByBounds(serial, 'session-detail-back');
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, `agent-chat-continued-in-${createdId}`, 60_000);
        await capture(environment, 'continued-in-link', artifacts);
        await finish(environment, artifacts, {
            continuedIn: 'linked',
            newSession: 'created-on-desktop-and-opened-with-handoff',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-CONT-AGENT-USAGE-02` (#2940): an Agent that cannot take over is listed disabled with its reason, and
 * offline the card's action and the sheet's list both disable.
 */
export async function executeMobileContinueAgentUnavailableScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { fixture } = await openUsageLimitedChat(environment);
    let isNetworkDisabled = false;
    try {
        await tapMobileCheckByBounds(serial, 'agent-chat-continue-in-agent');
        await waitForCheck(serial, 'session-continue-codex');
        const targets = (await mobileSemantics(serial)).filter(({ checkId }) =>
            checkId.startsWith('session-continue-'),
        );
        if (
            targets.every(
                ({ checkId, enabled }) => checkId === 'session-continue-cancel' || !!enabled,
            )
        )
            throw new Error('No Agent was listed as unavailable');
        await capture(environment, 'unavailable-target', artifacts);

        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await waitForCheck(serial, 'session-continue-status', 60_000);
        if (await isEnabled(serial, 'session-continue-codex'))
            throw new Error('Codex stayed selectable offline');
        await capture(environment, 'offline-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'session-continue-cancel');
        await waitForNoCheck(serial, 'agent-chat-continue-sheet');
        if (await isEnabled(serial, 'agent-chat-continue-in-agent'))
            throw new Error('The card kept its Continue action offline');
        await capture(environment, 'offline-card', artifacts);
        await finish(environment, artifacts, {
            offline: 'disabled-with-reason',
            unavailable: 'listed-with-reason',
        });
    } finally {
        if (isNetworkDisabled) await setMobileNetworkAvailable(serial, true);
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-CONT-AGENT-GUARD-01` (#2940): at the weekly usage guard, a control phone's guard card offers Continue in
 * Another Agent; picking Codex creates the new Session on Desktop and opens it.
 */
export async function executeMobileContinueAgentGuardScenario(
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
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        const { page } = fixture.running;
        await openAgentsInChat(page);
        // A running Chat is the only thing that answers `/usage`, so start one before the guard.
        await chat.send({ text: 'hi there' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        await writeFile(join(fixture.testDirectory, 'plan-weekly-guarded'), '');
        await waitForMobile(
            async () => {
                await pageRequest<AgentUsageReadout | null>(page, 'terminal.agentUsage', {
                    terminalId: chat.terminalId,
                });
                return (await chat.read()).usageGuard;
            },
            (guard) => guard !== undefined,
            PLAN_READING_WAIT_MS,
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat-usage-guard-continue-in-agent');
        await capture(environment, 'guard-card', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-usage-guard-continue-in-agent');
        await waitForCheck(serial, 'session-continue-codex');
        await capture(environment, 'guard-continue-sheet', artifacts);
        await continueInCodex(serial, page);
        await capture(environment, 'guard-continued-session', artifacts);
        await finish(environment, artifacts, {
            guard: 'card-offers-continue',
            newSession: 'created-on-desktop-and-opened-with-handoff',
        });
    } finally {
        await fixture.stop();
    }
}
