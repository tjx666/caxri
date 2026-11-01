import type { BootstrapState } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

type Page = Parameters<typeof pageRequest>[0];

const isArchived = async (page: Page, sessionId: string): Promise<boolean> =>
    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
        ({ id }) => id === sessionId,
    )?.archivedAt !== undefined;

/**
 * Pairs the phone and archives the fixture Session from the long-press sheet, up to the toast offering Undo. It stops
 * there: every further device read spends the toast's eight seconds before a case can press Undo.
 */
async function archiveFromSheet(
    serial: string,
    fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>>,
): Promise<{ page: Page; sessionId: string }> {
    const sessionId = fixture.allowedSessionId;
    if (!sessionId) throw new Error('Chat fixture is unavailable');
    const { page } = fixture.running;
    await fixture.pair();
    await waitForCheck(serial, `session-row-${sessionId}`);
    await tapMobileCheck(serial, `session-row-${sessionId}`, { isLongPress: true });
    await waitForCheck(serial, 'session-action-archive');
    await tapMobileCheckByBounds(serial, 'session-action-archive');
    await waitForCheck(serial, 'toast-action');
    await waitForMobile(
        () => isArchived(page, sessionId),
        (archived) => archived,
    );
    return { page, sessionId };
}

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
        const { page, sessionId } = await archiveFromSheet(serial, fixture);
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

/**
 * `MOB-SESSION-ARCHIVE-UNDO-02` (#3414): left alone, the Undo toast goes away by itself and the Session stays archived
 * on the phone and on Desktop.
 */
export async function executeMobileSessionArchiveTimeoutScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const { page, sessionId } = await archiveFromSheet(serial, fixture);
        await capture(environment, 'toast-shown', artifacts);
        await waitForNoCheck(serial, 'toast', 30_000);
        await waitForNoCheck(serial, `session-row-${sessionId}`);
        if (!(await isArchived(page, sessionId)))
            throw new Error('The Session came back by itself');
        await capture(environment, 'toast-gone', artifacts);
        await finish(environment, artifacts, { timeout: 'toast-dismissed-session-stays-archived' });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-SESSION-ARCHIVE-UNDO-03` (#3414): an Undo pressed while the phone has lost its network shows an error toast in
 * place of the Undo toast, and the Session stays archived.
 */
export async function executeMobileSessionArchiveUndoOfflineScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let isNetworkDisabled = false;
    try {
        const { page, sessionId } = await archiveFromSheet(serial, fixture);
        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await tapMobileCheckByBounds(serial, 'toast-action');
        await waitForNoCheck(serial, 'toast-action');
        await waitForCheck(serial, 'toast', 60_000);
        await capture(environment, 'undo-failed', artifacts);
        if (!(await isArchived(page, sessionId)))
            throw new Error('Offline Undo restored the Session');
        await finish(environment, artifacts, { offlineUndo: 'error-toast-session-stays-archived' });
    } finally {
        if (isNetworkDisabled) await setMobileNetworkAvailable(serial, true);
        await fixture.stop();
    }
}
