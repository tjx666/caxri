import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import { hasCheck, isReachedWithin, waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    coldStartMobileApp,
    mobileSemantics,
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
 * Whether the Session list comes back on screen, with no Session detail over it.
 */
const waitForSessionList = (serial: string, sessionId: string): Promise<boolean> =>
    isReachedWithin(
        serial,
        (nodes) =>
            !hasCheck(nodes, 'session-detail') && hasCheck(nodes, `session-row-${sessionId}`),
        15_000,
    );

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
        // Nothing was opened before the first Session, so its menu offers no way back.
        await tapMobileCheck(serial, 'session-detail-menu');
        await waitForCheck(serial, 'session-mark-read', 10_000);
        const isFirstMenuWithoutPrevious = !hasCheck(
            await mobileSemantics(serial),
            'session-previous',
        );
        await capture(environment, 'first-menu', artifacts);
        // Android Back closes the menu sheet before it would leave the Session.
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await isReachedWithin(serial, (nodes) => !hasCheck(nodes, 'session-mark-read'), 10_000);
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
        // Switching replaced the detail, so one Back leaves the Sessions instead of returning to Beta.
        await tapMobileCheck(serial, 'session-detail-back');
        const isListAfterMenuSwitch = await waitForSessionList(serial, first);

        // Alpha opens from the list again, so Beta is now the previous Session that a long-pressed Back opens.
        await tapMobileCheckByBounds(serial, `session-row-${first}`);
        await isTitleShown(serial, FIRST_TITLE);
        await tapMobileCheck(serial, 'session-detail-back', { isLongPress: true });
        const isLongPressBackToSecond = await isTitleShown(serial, SECOND_TITLE);
        await capture(environment, 'long-press-back', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        const isListAfterLongPressSwitch = await waitForSessionList(serial, first);
        let isListAfterSecondTap: boolean | null = null;
        if (!isListAfterLongPressSwitch) {
            // Diagnostic only: tells a swallowed first tap apart from a Back that cannot leave.
            await tapMobileCheck(serial, 'session-detail-back');
            isListAfterSecondTap = await waitForSessionList(serial, first);
        }
        await capture(environment, 'list', artifacts);

        // The list of opened Sessions survives the system ending the app: Beta was opened last, so it still leads back
        // to Alpha.
        await coldStartMobileApp(serial);
        await waitForCheck(serial, `session-row-${second}`, 60_000);
        await tapMobileCheckByBounds(serial, `session-row-${second}`);
        await isTitleShown(serial, SECOND_TITLE);
        await tapMobileCheck(serial, 'session-detail-menu');
        const isPreviousKeptAfterColdStart = await isReachedWithin(
            serial,
            (nodes) => hasCheck(nodes, 'session-previous'),
            10_000,
        );
        await capture(environment, 'cold-start-menu', artifacts);

        const checks = {
            firstOpened: isFirstOpened,
            firstMenuWithoutPrevious: isFirstMenuWithoutPrevious,
            secondOpened: isSecondOpened,
            menuOffersPrevious: isMenuEntryShown,
            menuOpensPrevious: isSwitchedToFirst,
            oneBackAfterMenuSwitchReachesList: isListAfterMenuSwitch,
            longPressBackOpensPrevious: isLongPressBackToSecond,
            oneBackAfterLongPressSwitchReachesList: isListAfterLongPressSwitch,
            previousKeptAfterColdStart: isPreviousKeptAfterColdStart,
        };
        await concludeScenario(environment, artifacts, { ...checks, isListAfterSecondTap }, checks);
    } finally {
        await mobile.stop();
    }
}
