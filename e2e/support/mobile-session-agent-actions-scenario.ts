import type { BootstrapState } from '@caxri/protocol';

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

type Page = Parameters<typeof pageRequest>[0];

const terminalState = async (page: Page, terminalId: string): Promise<string | undefined> =>
    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).terminals.find(
        ({ id }) => id === terminalId,
    )?.lastProcessState;

const isBotManaged = async (page: Page, sessionId: string): Promise<boolean> =>
    (
        await pageRequest<{ sessionIds: string[] }>(page, 'bot.managedSessions', {})
    ).sessionIds.includes(sessionId);

const openSheet = async (serial: string, sessionId: string, entry: string): Promise<void> => {
    await tapMobileCheck(serial, `session-row-${sessionId}`, { isLongPress: true });
    await waitForCheck(serial, entry);
};

const closedSheet = (serial: string) => waitForNoCheck(serial, 'session-actions-sheet', 60_000);

/**
 * `MOB-CHAT-SESSION-AGENT-ACTIONS-01` (#3238): a control phone reaches the Agent group of Desktop's Session menu. The
 * long-press sheet lists Restart, Detach, Hand Over to Caxri Bot; Restart and Detach confirm first; a detached Agent
 * offers Resume; a handed-over Session offers Take Back. Each change is read back from the paired Desktop.
 */
export async function executeMobileSessionAgentActionsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        const { page } = fixture.running;
        // Restart resumes the Agent's conversation, so one reply lands before the phone pairs.
        await chat.send({ text: 'hello' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && snapshot.items.length > 1,
        );
        await fixture.pair();
        await waitForCheck(serial, `session-row-${sessionId}`);

        await openSheet(serial, sessionId, 'session-action-hand-over');
        await capture(environment, 'agent-menu', artifacts);

        await tapMobileCheckByBounds(serial, 'session-action-restart');
        await waitForCheck(serial, 'session-restart-confirm');
        await capture(environment, 'restart-confirm', artifacts);
        const beforeRestart = (await chat.read()).items.length;
        await tapMobileCheckByBounds(serial, 'session-restart-confirm');
        await closedSheet(serial);
        // The restarted Agent resumes the same conversation, so the Chat comes back ready with its earlier items.
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.status === 'ready' && snapshot.items.length >= beforeRestart,
            60_000,
        );
        await waitForMobile(
            () => terminalState(page, chat.terminalId),
            (state) => state === 'running',
            60_000,
        );

        await openSheet(serial, sessionId, 'session-action-detach');
        await tapMobileCheckByBounds(serial, 'session-action-detach');
        await waitForCheck(serial, 'session-detach-confirm');
        await capture(environment, 'detach-confirm', artifacts);
        await tapMobileCheckByBounds(serial, 'session-detach-confirm');
        await closedSheet(serial);
        await waitForMobile(
            () => terminalState(page, chat.terminalId),
            (state) => state === 'detached',
        );
        await openSheet(serial, sessionId, 'session-action-resume');
        await capture(environment, 'detached-resume', artifacts);
        await tapMobileCheckByBounds(serial, 'session-action-resume');
        await closedSheet(serial);
        await waitForMobile(
            () => terminalState(page, chat.terminalId),
            (state) => state === 'running',
            60_000,
        );

        await openSheet(serial, sessionId, 'session-action-hand-over');
        await tapMobileCheckByBounds(serial, 'session-action-hand-over');
        await closedSheet(serial);
        await waitForMobile(
            () => isBotManaged(page, sessionId),
            (managed) => managed,
        );
        await openSheet(serial, sessionId, 'session-action-take-back');
        await capture(environment, 'handed-over-take-back', artifacts);
        await tapMobileCheckByBounds(serial, 'session-action-take-back');
        await closedSheet(serial);
        await waitForMobile(
            () => isBotManaged(page, sessionId),
            (managed) => !managed,
        );

        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await tapMobileCheckByBounds(serial, 'session-detail-menu');
        for (const entry of [
            'session-menu-restart',
            'session-menu-detach',
            'session-menu-hand-over',
        ])
            // eslint-disable-next-line no-await-in-loop -- One menu reading proves each entry in turn.
            await waitForCheck(serial, entry);
        await capture(environment, 'detail-menu', artifacts);

        await finish(environment, artifacts, {
            detach: 'confirmed-and-detached-on-desktop',
            handOver: 'managed-by-caxri-bot-on-desktop',
            restart: 'confirmed',
            resume: 'resumed-on-desktop',
            takeBack: 'released-on-desktop',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-SESSION-AGENT-ACTIONS-02` (#3238): offline, the sheet's Agent entries disable and say the phone must
 * reconnect. Hand Over needs the menu state, which an offline phone cannot read, so it is absent rather than disabled.
 */
export async function executeMobileSessionAgentActionsOfflineScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let isNetworkDisabled = false;
    try {
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        await waitForCheck(serial, `session-row-${sessionId}`);
        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await openSheet(serial, sessionId, 'session-agent-actions-offline');
        const nodes = await mobileSemantics(serial);
        for (const id of ['session-action-restart', 'session-action-detach']) {
            const node = nodes.find(({ checkId }) => checkId === id);
            if (!node) throw new Error(`${id} is missing offline`);
            if (node.enabled) throw new Error(`${id} stayed enabled offline`);
        }
        await capture(environment, 'offline-sheet', artifacts);
        await finish(environment, artifacts, { offline: 'disabled-with-reason' });
    } finally {
        if (isNetworkDisabled) await setMobileNetworkAvailable(serial, true);
        await fixture.stop();
    }
}
