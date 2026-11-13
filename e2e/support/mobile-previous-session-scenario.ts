import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import { hasCheck, isReachedWithin, waitForCheck } from './mobile-agent-chat-helpers';
import {
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const FIRST_TITLE = 'Alpha audit';
const SECOND_TITLE = 'Beta review';

/**
 * Whether the open Session detail shows `title`, polled until it does or the wait ends.
 */
const isTitleShown = async (serial: string, title: string): Promise<boolean> => {
    try {
        await waitForMobile(
            () =>
                observeMobileNode(serial, 'session-detail-title', { kind: 'equals', value: title }),
            (observation) => observation.exists && observation.textMatches === true,
            15_000,
        );
        return true;
    } catch {
        return false;
    }
};

/**
 * `MOB-SESSION-PREVIOUS-01`: after opening one Session and then another from the list, the second Session's menu offers
 * "上一个会话" naming the first, and choosing it opens the first in place. Long-pressing Back then returns to the second,
 * and a single Back from there lands on the Session list, since switching replaces the detail instead of stacking it
 * (issue #3971).
 */
export async function executeMobilePreviousSessionScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    // No Agent launches here; the mode keeps one plain shell Session in the allowed Project.
    const mobile = await createMobileAcceptanceFixture({ mode: 'launch-failure', serial });
    try {
        const { page } = mobile.running;
        const first = mobile.allowedSessionId;
        if (!first) throw new Error('The allowed Session is unavailable');
        const created = await pageRequest<{ session: { id: string; projectId: string } }>(
            page,
            'session.create',
            { projectId: mobile.allowedProjectId, defaultAgent: 'shell' },
        );
        const second = created.session.id;
        await pageRequest(page, 'session.rename', { sessionId: first, title: FIRST_TITLE });
        await pageRequest(page, 'session.rename', { sessionId: second, title: SECOND_TITLE });
        await mobile.pair({ projectIds: [], readyCheckId: `session-row-${second}` });

        await tapMobileCheckByBounds(serial, `session-row-${first}`);
        const isFirstOpened = await isTitleShown(serial, FIRST_TITLE);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, `session-row-${second}`);
        await tapMobileCheckByBounds(serial, `session-row-${second}`);
        const isSecondOpened = await isTitleShown(serial, SECOND_TITLE);

        await tapMobileCheck(serial, 'session-detail-menu');
        const isMenuEntryShown = await isReachedWithin(
            serial,
            (nodes) => hasCheck(nodes, 'session-previous'),
            10_000,
        );
        await capture(environment, 'menu', artifacts);
        if (isMenuEntryShown) await tapMobileCheck(serial, 'session-previous');
        const isSwitchedToFirst = isMenuEntryShown && (await isTitleShown(serial, FIRST_TITLE));
        await capture(environment, 'switched', artifacts);

        await tapMobileCheck(serial, 'session-detail-back', { isLongPress: true });
        const isLongPressBackToSecond = await isTitleShown(serial, SECOND_TITLE);

        await tapMobileCheck(serial, 'session-detail-back');
        const isListAfterOneBack = await isReachedWithin(
            serial,
            (nodes) =>
                !hasCheck(nodes, 'session-detail') && hasCheck(nodes, `session-row-${first}`),
            15_000,
        );
        await capture(environment, 'list', artifacts);

        const checks = {
            firstOpened: isFirstOpened,
            secondOpened: isSecondOpened,
            menuOffersPrevious: isMenuEntryShown,
            menuOpensPrevious: isSwitchedToFirst,
            longPressBackOpensPrevious: isLongPressBackToSecond,
            oneBackReachesList: isListAfterOneBack,
        };
        await concludeScenario(environment, artifacts, checks, checks);
    } finally {
        await mobile.stop();
    }
}
