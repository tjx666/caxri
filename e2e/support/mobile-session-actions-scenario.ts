import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

const sessionIds = async (page: Parameters<typeof pageRequest>[0]): Promise<string[]> =>
    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.map(({ id }) => id);

/**
 * `MOB-CHAT-SESSION-ACTIONS-01`: a control phone reaches Desktop's Session actions. The long-press sheet lists Fork,
 * Continue in Another Agent, and Delete beside Pin, Rename, and Archive; Rename offers Rename with AI; Continue lists
 * the other Agents with the reason each one is unavailable. Fork from the Session menu opens the new Session, and
 * Delete asks first, then removes the fork from the phone and from Desktop.
 */
export async function executeMobileSessionActionsScenario(
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
        // Fork needs an Agent conversation to copy, so one reply lands before the phone pairs.
        await chat.send({ text: 'hello' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && snapshot.items.length > 1,
        );
        await fixture.pair();
        await waitForCheck(serial, `session-row-${sessionId}`);

        await tapMobileCheck(serial, `session-row-${sessionId}`, { isLongPress: true });
        await waitForCheck(serial, 'session-action-delete');
        await capture(environment, 'actions-sheet', artifacts);

        await tapMobileCheckByBounds(serial, 'session-action-rename');
        await waitForCheck(serial, 'session-rename-ai');
        await capture(environment, 'rename-with-ai', artifacts);
        await tapMobileCheckByBounds(serial, 'session-rename-cancel');
        await waitForCheck(serial, 'session-action-continue');

        await tapMobileCheckByBounds(serial, 'session-action-continue');
        await waitForCheck(serial, 'session-continue-cancel');
        await waitForNoCheck(serial, 'session-continue-status');
        await capture(environment, 'continue-targets', artifacts);
        await tapMobileCheckByBounds(serial, 'session-continue-cancel');
        await waitForCheck(serial, 'session-action-fork');
        await tapMobileCheckByBounds(serial, 'session-actions-cancel');
        await waitForNoCheck(serial, 'session-actions-sheet');

        const before = await sessionIds(page);
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await tapMobileCheckByBounds(serial, 'session-detail-menu');
        await waitForCheck(serial, 'session-menu-fork');
        await capture(environment, 'detail-menu', artifacts);
        await tapMobileCheckByBounds(serial, 'session-menu-fork');
        const forkedId = (
            await waitForMobile(
                () => sessionIds(page),
                (ids) => ids.some((id) => !before.includes(id)),
            )
        ).find((id) => !before.includes(id));
        if (!forkedId) throw new Error('Fork did not create a Session');
        await waitForCheck(serial, 'session-detail-title');
        await capture(environment, 'forked-session', artifacts);

        await tapMobileCheckByBounds(serial, 'session-detail-menu');
        await tapMobileCheckByBounds(serial, 'session-menu-delete');
        await waitForCheck(serial, 'session-delete-confirm');
        await capture(environment, 'delete-confirm', artifacts);
        await tapMobileCheckByBounds(serial, 'session-delete-confirm');
        await waitForNoCheck(serial, 'session-actions-sheet');
        await waitForNoCheck(serial, `session-row-${forkedId}`);
        await waitForCheck(serial, `session-row-${sessionId}`);
        await waitForMobile(
            () => sessionIds(page),
            (ids) => !ids.includes(forkedId),
        );
        await capture(environment, 'deleted', artifacts);
        await finish(environment, artifacts, {
            continueTargets: 'listed',
            delete: 'confirmed-and-removed-on-desktop',
            fork: 'opened-new-session',
            renameWithAi: 'offered',
        });
    } finally {
        await fixture.stop();
    }
}
