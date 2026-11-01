import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
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
 * Sideways drift during a vertical drag, short of the list's 24dp Project swipe activation, so a scroll that wanders a
 * little must keep scrolling instead of switching Project.
 */
const DRIFT_DP = 16;

type Fixture = Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;

/**
 * Pairs on the empty list the fixture waits for, then creates the idle Sessions, which reach the phone as live updates.
 */
async function pairWithIdleSessions(fixture: Fixture): Promise<string[]> {
    await fixture.pair();
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
    return ids;
}

/**
 * Whether the Project filter chip `checkId` is the selected one.
 */
const isFilterSelected = (nodes: MobileSemanticNode[], checkId: string): boolean =>
    nodes.some((node) => node.checkId === checkId && node.selected);

/**
 * Drags across the middle of the Session list from `fromShare` to `toShare` of its width, inside the system Back
 * gesture edges.
 */
async function swipeList(serial: string, fromShare: number, toShare: number): Promise<void> {
    const list = checkBounds(await mobileSemantics(serial), 'session-list');
    if (!list) throw new Error('The Session list is not laid out');
    const width = list.right - list.left;
    const y = String(Math.floor((list.top + list.bottom) / 2));
    await adbShell(serial, [
        'input',
        'swipe',
        String(Math.floor(list.left + width * fromShare)),
        y,
        String(Math.floor(list.left + width * toShare)),
        y,
        '300',
    ]);
}

/**
 * `MOB-CHAT-27`: a vertical drag that drifts sideways scrolls the Session list without switching Project, and the next
 * tap opens the Session; a deliberate left swipe moves from All to the next Project chip, another left swipe at the
 * last chip stays put, and a right swipe returns to All.
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
        if (!isFilterSelected(nodes, 'project-filter-all'))
            throw new Error('The list did not start on All');
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
        const afterDrift = await mobileSemantics(serial);
        const after = checkBounds(afterDrift, `session-row-${target}`);
        if (!after) throw new Error('The idle Session row left the screen');
        if (after.left !== row.left) throw new Error('The drifting scroll moved the row sideways');
        if (!isFilterSelected(afterDrift, 'project-filter-all'))
            throw new Error('The drifting scroll switched Project');
        await capture(environment, 'after-drifting-scroll', artifacts);
        await tapMobileCheck(serial, `session-row-${target}`);
        await waitForCheck(serial, 'session-detail-back');
        await capture(environment, 'opened-after-scroll', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForCheck(serial, 'session-group-idle');

        const projectChip = `project-filter-${fixture.allowedProjectId}`;
        await swipeList(serial, 0.8, 0.2);
        await waitForMobile(
            () => mobileSemantics(serial),
            (current) => isFilterSelected(current, projectChip),
        );
        await capture(environment, 'swiped-to-project', artifacts);
        // The phone only sees one Project, so it is the last chip and a further left swipe has nowhere to go.
        await swipeList(serial, 0.8, 0.2);
        if (!isFilterSelected(await mobileSemantics(serial), projectChip))
            throw new Error('A left swipe past the last Project left it');
        await swipeList(serial, 0.2, 0.8);
        await waitForMobile(
            () => mobileSemantics(serial),
            (current) => isFilterSelected(current, 'project-filter-all'),
        );
        await capture(environment, 'swiped-back-to-all', artifacts);
        await finish(environment, artifacts, {
            driftingScroll: 'scrolled-without-switching-project',
            leftSwipe: 'all-to-project',
            leftSwipeAtLastProject: 'stayed',
            rightSwipe: 'project-to-all',
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
