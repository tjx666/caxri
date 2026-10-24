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

type Fixture = Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;

/**
 * Creates the idle Sessions before pairing, so the phone's first list already holds a long Idle group.
 */
async function pairWithIdleSessions(fixture: Fixture): Promise<string[]> {
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
    return ids;
}

/**
 * `MOB-CHAT-27`: a vertical drag that drifts sideways scrolls the Session list without revealing Archive, so the row
 * stays in place and the next tap opens the Session; a deliberate left swipe still reveals Archive, and the tap after
 * it only closes the action.
 */
export async function executeMobileSessionSwipeScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const ids = await pairWithIdleSessions(fixture);
        await waitForCheck(serial, 'session-group-idle');
        const nodes = await mobileSemantics(serial);
        const target = ids.find((id) => checkBounds(nodes, `session-row-${id}`));
        const row = target && checkBounds(nodes, `session-row-${target}`);
        if (!target || !row) throw new Error('No idle Session row is on screen');
        const display = await mobileDisplayState(serial);
        const density = (display.density.override ?? display.density.physical) / 160;
        const x = Math.floor((row.left + row.right) / 2);
        const y = Math.floor((row.top + row.bottom) / 2);
        const drift = Math.round(DRIFT_DP * density);
        const lift = Math.round(120 * density);
        await capture(environment, 'before-drifting-scroll', artifacts);
        // Up and back down, so the same row returns under the finger for the tap that follows.
        await adbShell(serial, [
            'input',
            'swipe',
            String(x),
            String(y),
            String(x - drift),
            String(y - lift),
            '400',
        ]);
        await capture(environment, 'after-drifting-scroll-up', artifacts);
        await adbShell(serial, [
            'input',
            'swipe',
            String(x - drift),
            String(y - lift),
            String(x),
            String(y),
            '400',
        ]);
        const after = checkBounds(await mobileSemantics(serial), `session-row-${target}`);
        if (!after) throw new Error('The idle Session row left the screen');
        if (after.left !== row.left) throw new Error('The drifting scroll moved the row sideways');
        await capture(environment, 'after-drifting-scroll', artifacts);
        await tapMobileCheck(serial, `session-row-${target}`);
        await waitForCheck(serial, 'session-detail-back');
        await capture(environment, 'opened-after-scroll', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, 'session-group-idle');

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
        const swiped = checkBounds(await mobileSemantics(serial), `session-row-${target}`);
        if (!swiped || swiped.left >= settled.left)
            throw new Error('The left swipe did not reveal Archive');
        await capture(environment, 'archive-revealed', artifacts);
        await tapMobileCheck(serial, `session-row-${target}`);
        await waitForNoCheck(serial, 'session-detail-back', 3_000);
        await finish(environment, artifacts, {
            driftingScroll: 'scrolled-without-archive',
            leftSwipe: 'archive-revealed',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-28`: a long Idle group shows five Sessions and a `Show 6 more` row that adds the rest, and tapping the
 * group heading collapses it to the heading with its count and opens it again.
 */
export async function executeMobileSessionGroupsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const ids = await pairWithIdleSessions(fixture);
        await waitForCheck(serial, 'session-group-reveal-idle');
        const windowed = await mobileSemantics(serial);
        const shownIdle = ids.filter((id) => checkBounds(windowed, `session-row-${id}`)).length;
        if (shownIdle !== 5)
            throw new Error(`The Idle group shows ${shownIdle} Sessions before a reveal`);
        await capture(environment, 'idle-windowed', artifacts);

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
        await capture(environment, 'idle-reopened', artifacts);
        await finish(environment, artifacts, {
            collapse: 'collapsed-and-reopened',
            reveal: 'idle-revealed',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
