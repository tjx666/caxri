import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

const isArchived = async (
    page: Parameters<typeof pageRequest>[0],
    sessionId: string,
): Promise<boolean> =>
    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
        ({ id }) => id === sessionId,
    )?.archivedAt !== undefined;

/**
 * `MOB-SESSION-ARCHIVE-UNDO-01` (#3414): archiving from the long-press sheet confirms with a toast that offers Undo.
 * Undo puts the Session back in the phone's list and unarchives it on the paired Desktop.
 */
export async function executeMobileSessionArchiveUndoScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Chat fixture is unavailable');
        const { page } = fixture.running;
        await fixture.pair();
        await waitForCheck(serial, `session-row-${sessionId}`);

        await tapMobileCheck(serial, `session-row-${sessionId}`, { isLongPress: true });
        await waitForCheck(serial, 'session-action-archive');
        await tapMobileCheckByBounds(serial, 'session-action-archive');
        await waitForCheck(serial, 'toast-action');
        await waitForNoCheck(serial, `session-row-${sessionId}`);
        await waitForMobile(
            () => isArchived(page, sessionId),
            (archived) => archived,
        );
        await capture(environment, 'archived-toast', artifacts);

        await tapMobileCheckByBounds(serial, 'toast-action');
        await waitForNoCheck(serial, 'toast-action');
        await waitForCheck(serial, `session-row-${sessionId}`);
        await waitForMobile(
            () => isArchived(page, sessionId),
            (archived) => !archived,
        );
        await capture(environment, 'restored', artifacts);
        await finish(environment, artifacts, {
            archive: 'toast-offered-undo',
            undo: 'restored-on-phone-and-desktop',
        });
    } finally {
        await fixture.stop();
    }
}
