import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

/**
 * `MOB-CHAT-21`: the phone's Session list uses Desktop's groups and pin. A finished reply leaves the Session under
 * Needs attention; pinning it from the long-press sheet lists it under Pinned and, while it still needs attention,
 * again under Needs attention, and Desktop reads the same pin. Opening it shows the turn's file change with its long
 * lines wrapped, and unpinning on Desktop removes the Pinned group from the phone.
 */
export async function executeMobileSessionPinScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: 'widediff' });
        const changed = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId && snapshot.items.some((item) => item.type === 'fileChange'),
        );
        const turnId = changed.items.findLast((item) => item.type === 'fileChange')?.turnId;
        if (!turnId) throw new Error('The wide diff turn did not finish');
        await fixture.pair();
        await waitForCheck(serial, 'session-group-attention');
        await capture(environment, 'groups', artifacts);

        await tapMobileCheck(serial, `session-row-${sessionId}`, { isLongPress: true });
        await waitForCheck(serial, 'session-action-pin');
        await capture(environment, 'actions-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'session-action-pin');
        await waitForNoCheck(serial, 'session-actions-sheet');
        await waitForCheck(serial, 'session-group-pinned');
        await waitForCheck(serial, 'session-group-attention');
        await capture(environment, 'pinned', artifacts);
        await waitForMobile(
            () => pageRequest<BootstrapState>(fixture.running.page, 'app.bootstrap'),
            (state) => state.sessions.find(({ id }) => id === sessionId)?.pinnedAt !== undefined,
        );

        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, `agent-chat-turn-changes-${turnId}`);
        await tapMobileCheckByBounds(serial, `agent-chat-turn-changes-${turnId}`);
        await capture(environment, 'wrapped-diff-card', artifacts);

        await pageRequest(fixture.running.page, 'session.setPinned', { sessionId, pinned: false });
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForNoCheck(serial, 'session-group-pinned');
        await capture(environment, 'unpinned', artifacts);
        await finish(environment, artifacts, {
            desktopPin: 'mirrored-both-ways',
            diffCard: 'wrapped',
            groups: 'pinned-and-attention',
        });
    } finally {
        await fixture.stop();
    }
}
