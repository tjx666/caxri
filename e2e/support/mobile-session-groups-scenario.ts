import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileDisplayState,
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * Enough idle Sessions that the Idle group windows to five and offers `Show 6 more`.
 */
const IDLE_SESSION_COUNT = 11;

/**
 * Sideways drift during a vertical drag, past the old 10dp swipe activation and short of the 24dp one, so it reproduces
 * the scroll that used to open the Archive action.
 */
const DRIFT_DP = 16;

/**
 * `MOB-CHAT-27`: the phone's Session list stays scrollable and compact. A vertical drag that drifts sideways scrolls
 * without revealing Archive, so the next tap opens the Session; a deliberate left swipe still reveals it. A long Idle
 * group shows five Sessions and a reveal row that adds the rest, and tapping a group heading collapses it to the
 * heading with its count and opens it again.
 */
export async function executeMobileSessionGroupsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const ids: string[] = [];
        for (let index = 0; index < IDLE_SESSION_COUNT; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- Sessions are created in order so their recency is fixed.
            const created = await pageRequest<{ session: { id: string } }>(
                fixture.running.page,
                'session.create',
                { projectId: fixture.allowedProjectId, defaultAgent: 'shell' },
            );
            ids.push(created.session.id);
        }
        await fixture.pair();
        await waitForCheck(serial, 'session-group-reveal-idle');
        const windowed = await mobileSemantics(serial);
        const shownIdle = ids.filter((id) => checkBounds(windowed, `session-row-${id}`)).length;
        if (shownIdle > 5)
            throw new Error(`The Idle group shows ${shownIdle} Sessions before a reveal`);
        await capture(environment, 'idle-windowed', artifacts);

        // A vertical drag with sideways drift, started on a row, must scroll rather than open Archive.
        const display = await mobileDisplayState(serial);
        const density = (display.density.override ?? display.density.physical) / 160;
        const target = ids.find((id) => checkBounds(windowed, `session-row-${id}`));
        const row = target && checkBounds(windowed, `session-row-${target}`);
        if (!target || !row) throw new Error('No idle Session row is on screen');
        const x = Math.floor((row.left + row.right) / 2);
        const y = Math.floor((row.top + row.bottom) / 2);
        const drift = Math.round(DRIFT_DP * density);
        await adbShell(serial, [
            'input',
            'swipe',
            String(x),
            String(y),
            String(x - drift),
            String(y - Math.round(120 * density)),
            '400',
        ]);
        await adbShell(serial, [
            'input',
            'swipe',
            String(x - drift),
            String(y - Math.round(120 * density)),
            String(x),
            String(y),
            '400',
        ]);
        await capture(environment, 'after-drifting-scroll', artifacts);
        await tapMobileCheck(serial, `session-row-${target}`);
        await waitForCheck(serial, 'session-detail-back');
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, 'session-group-idle');

        // A deliberate left swipe still reveals Archive; the next tap only closes it.
        const settled = checkBounds(await mobileSemantics(serial), `session-row-${target}`);
        if (!settled) throw new Error('The idle Session row left the screen');
        const rowY = Math.floor((settled.top + settled.bottom) / 2);
        await adbShell(serial, [
            'input',
            'swipe',
            String(Math.floor(settled.right * 0.8)),
            String(rowY),
            String(Math.floor(settled.right * 0.3)),
            String(rowY),
            '300',
        ]);
        await capture(environment, 'archive-revealed', artifacts);
        await tapMobileCheck(serial, `session-row-${target}`);
        await waitForNoCheck(serial, 'session-detail-back', 3_000);

        await tapMobileCheckByBounds(serial, 'session-group-reveal-idle');
        await waitForNoCheck(serial, 'session-group-reveal-idle');
        await capture(environment, 'idle-revealed', artifacts);

        await tapMobileCheckByBounds(serial, 'session-group-idle');
        const collapsed = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => ids.every((id) => !checkBounds(nodes, `session-row-${id}`)),
        );
        if (!checkBounds(collapsed, 'session-group-idle'))
            throw new Error('The Idle heading left with its rows');
        await capture(environment, 'idle-collapsed', artifacts);
        await tapMobileCheckByBounds(serial, 'session-group-idle');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => ids.some((id) => checkBounds(nodes, `session-row-${id}`)),
        );
        await finish(environment, artifacts, {
            collapse: 'collapsed-and-reopened',
            driftingScroll: 'scrolled-without-archive',
            leftSwipe: 'archive-revealed',
            reveal: 'idle-revealed',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
