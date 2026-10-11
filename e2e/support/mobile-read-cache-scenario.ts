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
    adbShell,
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

/**
 * The read cache writes one second after the live view settles; this leaves room for that write before the app dies.
 */
const READ_CACHE_SETTLE_MS = 2_500;

const coldStart = async (serial: string): Promise<void> => {
    await adbShell(serial, ['am', 'force-stop', 'com.caxri.mobile']);
    await adbShell(serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
};

/**
 * `MOB-CHAT-06`: a phone that read the Session list and one Chat online is cold-started without a network. It shows the
 * saved list and the saved Chat, each labeled as saved, explains that a Chat it never opened needs the connection, and
 * replaces both saved copies with live reads once the network returns.
 */
export async function executeMobileReadCacheScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let isNetworkDisabled = false;
    try {
        const { page } = fixture.running;
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId || !fixture.allowedProjectId)
            throw new Error('Chat fixture is unavailable');
        const openedRow = `session-row-${fixture.allowedSessionId}`;
        // A second Chat the phone lists but never opens, so nothing of its messages is saved.
        const unopened = await pageRequest<{ session: { id: string } }>(page, 'session.create', {
            projectId: fixture.allowedProjectId,
            defaultAgent: 'codex',
            surface: 'chat',
        });
        const unopenedRow = `session-row-${unopened.session.id}`;
        await waitForCheck(serial, unopenedRow);

        await tapMobileCheck(serial, openedRow);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'live-chat', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, unopenedRow);
        await capture(environment, 'live-list', artifacts);
        await new Promise((resolve) => setTimeout(resolve, READ_CACHE_SETTLE_MS));

        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await coldStart(serial);
        await waitForCheck(serial, 'session-list-saved', 60_000);
        const offlineList = await mobileSemantics(serial);
        if (!hasCheck(offlineList, openedRow) || !hasCheck(offlineList, unopenedRow))
            throw new Error('The saved Session list lost a row');
        await capture(environment, 'offline-list', artifacts);

        await tapMobileCheck(serial, openedRow);
        await waitForCheck(serial, 'agent-chat-saved');
        if (hasCheck(await mobileSemantics(serial), 'agent-chat-status-empty'))
            throw new Error('The saved Chat lost its messages');
        await capture(environment, 'offline-chat', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');

        await tapMobileCheck(serial, unopenedRow);
        await waitForCheck(serial, 'agent-chat-status-offline');
        await capture(environment, 'offline-unopened', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, 'session-list-saved');

        await setMobileNetworkAvailable(serial, true);
        isNetworkDisabled = false;
        await waitForNoCheck(serial, 'session-list-saved', 60_000);
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);
        await capture(environment, 'reconnected-list', artifacts);
        await tapMobileCheck(serial, openedRow);
        await waitForCheck(serial, 'agent-chat');
        await waitForNoCheck(serial, 'agent-chat-saved');
        await capture(environment, 'reconnected-chat', artifacts);

        await finish(environment, artifacts, {
            coldStartOffline: 'saved-list-and-chat-labeled',
            reconnect: 'live-reads-replaced-saved-copies',
            status: 'passed',
            unopenedChatOffline: 'reconnect-message',
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
