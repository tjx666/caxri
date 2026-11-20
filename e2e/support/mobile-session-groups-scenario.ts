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
 * Sideways drift during a vertical drag: past a swipeable row's 20dp activation, so a scroll that wanders that far must
 * keep scrolling instead of opening a row (#2540).
 */
const DRIFT_DP = 22;

/**
 * Long enough for a released swipe's settle animation, and a wrong filter switch after it, to land.
 */
const SETTLE_MS = 600;

const pause = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

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
 * The height at which a list swipe crosses the list: the Idle group heading's middle. A control device can swipe every
 * Session row open, and a left drag that starts on such a row belongs to the row, so a list swipe goes across the
 * heading instead.
 */
function pagingY(nodes: MobileSemanticNode[]): number {
    const heading = checkBounds(nodes, 'session-group-idle');
    if (!heading) throw new Error('The Idle group heading is not laid out');
    return Math.floor((heading.top + heading.bottom) / 2);
}

/**
 * Drags across the Session list from `fromShare` to `toShare` of its width, inside the system Back gesture edges, at
 * {@link pagingY}.
 */
async function swipeList(serial: string, fromShare: number, toShare: number): Promise<void> {
    const nodes = await mobileSemantics(serial);
    const list = checkBounds(nodes, 'session-list');
    if (!list) throw new Error('The Session list is not laid out');
    const width = list.right - list.left;
    const y = String(pagingY(nodes));
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
 * The header's icon buttons sit in the brand row, which ends above the full-width Project chips, and the two buttons
 * share a center line within one dp.
 */
function assertHeaderLayout(nodes: MobileSemanticNode[], density: number): void {
    const bounds = (id: string) => {
        const found = checkBounds(nodes, id);
        if (!found) throw new Error(`${id} is not laid out`);
        return found;
    };
    const chip = bounds('project-filter-all');
    const search = bounds('session-search-button');
    const menu = bounds('computer-menu-button');
    for (const [id, button] of [
        ['session-search-button', search],
        ['computer-menu-button', menu],
    ] as const)
        if (button.bottom > chip.top + density)
            throw new Error(`${id} is not in the brand row above the Project chips`);
    if (Math.abs((search.top + search.bottom) / 2 - (menu.top + menu.bottom) / 2) > density)
        throw new Error(
            'session-search-button and computer-menu-button do not share a center line',
        );
}

/**
 * `MOB-CHAT-27`: a vertical drag that drifts sideways scrolls the Session list without switching Project, and the next
 * tap opens the Session. A short left drag on a row opens its actions and a right drag closes it. A deliberate left or
 * right swipe across the list never switches Project; only a chip tap does. The header's icon buttons sit in the brand
 * row above the Project chips.
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
        // All eleven rows overflow the phone, so the drifting drag below has a list that can really scroll.
        await tapMobileCheckByBounds(serial, 'session-group-reveal-idle');
        await waitForNoCheck(serial, 'session-group-reveal-idle');
        const nodes = await mobileSemantics(serial);
        const target = ids.find((id) => checkBounds(nodes, `session-row-${id}`));
        const row = target && checkBounds(nodes, `session-row-${target}`);
        if (!target || !row) throw new Error('No idle Session row is on screen');
        if (!isFilterSelected(nodes, 'project-filter-all'))
            throw new Error('The list did not start on All');
        const display = await mobileDisplayState(serial);
        const density = (display.density.override ?? display.density.physical) / 160;
        assertHeaderLayout(nodes, density);
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
        const lifted = checkBounds(await mobileSemantics(serial), `session-row-${target}`);
        if (lifted && lifted.top >= row.top)
            throw new Error('The drifting drag did not scroll the list');
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

        // A short, slow left drag on one row belongs to the row: it opens the row's Archive and never switches Project.
        // The newest Session is the top row, fully on screen, so the opened row and its action read in the capture.
        const dragged = ids.at(-1)!;
        const settled = checkBounds(await mobileSemantics(serial), `session-row-${dragged}`);
        if (!settled) throw new Error('The top idle Session row is not on screen');
        const rowY = String(Math.floor((settled.top + settled.bottom) / 2));
        const rowWidth = settled.right - settled.left;
        await adbShell(serial, [
            'input',
            'swipe',
            String(Math.floor(settled.left + rowWidth * 0.75)),
            rowY,
            String(Math.floor(settled.left + rowWidth * 0.6)),
            rowY,
            '800',
        ]);
        await pause(SETTLE_MS);
        const afterRowDrag = await mobileSemantics(serial);
        const opened = checkBounds(afterRowDrag, `session-row-${dragged}`);
        if (!opened || opened.left >= settled.left)
            throw new Error('A left row drag did not open the row');
        if (!checkBounds(afterRowDrag, `session-row-archive-${dragged}`))
            throw new Error('The opened row shows no Archive action');
        if (!isFilterSelected(afterRowDrag, 'project-filter-all'))
            throw new Error('A short row drag switched Project');
        await capture(environment, 'short-row-drag', artifacts);
        // A right drag on the open row closes it.
        await adbShell(serial, [
            'input',
            'swipe',
            String(Math.floor(settled.left + rowWidth * 0.3)),
            rowY,
            String(Math.floor(settled.left + rowWidth * 0.6)),
            rowY,
            '300',
        ]);
        await pause(SETTLE_MS);
        const closedNodes = await mobileSemantics(serial);
        if (checkBounds(closedNodes, `session-row-${dragged}`)?.left !== settled.left)
            throw new Error('A right drag did not close the open row');
        if (!isFilterSelected(closedNodes, 'project-filter-all'))
            throw new Error('Closing the open row switched Project');
        await capture(environment, 'row-drag-closed', artifacts);

        // A deliberate swipe across the list, either way, keeps the Project filter: only a chip changes it.
        for (const [from, to, name] of [
            [0.8, 0.2, 'left'],
            [0.2, 0.8, 'right'],
        ] as const) {
            // eslint-disable-next-line no-await-in-loop -- each swipe is observed on the screen the previous one left.
            await swipeList(serial, from, to);
            for (let sample = 0; sample < 3; sample += 1) {
                // eslint-disable-next-line no-await-in-loop -- each sample is a timed observation of the same screen.
                await pause(SETTLE_MS);
                // eslint-disable-next-line no-await-in-loop -- see above.
                const swiped = await mobileSemantics(serial);
                if (!isFilterSelected(swiped, 'project-filter-all'))
                    throw new Error(`A ${name} list swipe switched Project`);
                // The swipe crosses the Idle heading; it must not count as a tap that folds the group.
                if (!checkBounds(swiped, `session-row-${dragged}`))
                    throw new Error(`A ${name} list swipe folded the Idle group`);
            }
            // eslint-disable-next-line no-await-in-loop -- one capture per swipe.
            await capture(environment, `${name}-swipe-kept-project`, artifacts);
        }
        const projectChip = `project-filter-${fixture.allowedProjectId}`;
        await tapMobileCheck(serial, projectChip);
        await waitForMobile(
            () => mobileSemantics(serial),
            (current) => isFilterSelected(current, projectChip),
        );
        await capture(environment, 'chip-chose-project', artifacts);
        await finish(environment, artifacts, {
            driftingScroll: 'scrolled-without-switching-project',
            headerLayout: 'icon-buttons-in-brand-row-above-chips',
            leftSwipe: 'kept-project',
            rightSwipe: 'kept-project',
            chipTap: 'chose-project',
            shortRowDrag: 'opened-archive-no-switch-right-drag-closed',
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
