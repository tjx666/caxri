import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    mobileDisplayState,
    mobileRegionFingerprint,
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
 * Sideways drift during a vertical drag: past a swipeable row's 20dp activation but short of the list's 24dp Project
 * swipe activation, so a scroll that wanders that far must keep scrolling instead of opening a row (#2540) or switching
 * Project.
 */
const DRIFT_DP = 22;

/**
 * Long enough for a released swipe's settle animation and the filter switch after it to land.
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
 * The height at which a page swipe crosses the list: the Idle group heading's middle. A control device can swipe every
 * Session row open, and a left drag that starts on such a row belongs to the row, so a page swipe goes across the
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
 * Drags across the Session list like {@link swipeList} but holds the finger down past the activation slop, so the frame
 * is compared while the gesture is live: the list must follow the finger like a pager, with the next Project's page
 * sliding in beside it. The Project filters' highlight travels with it, so both the current and the next chip change
 * while the finger is held. UIAutomator waits for an idle screen, so the list and chips are compared by their pixels.
 */
async function holdSwipeFollowingFinger(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    pages: { current: string; next: string },
    chips: { current: string; next: string },
    fromShare: number,
    toShare: number,
): Promise<void> {
    const { serial } = environment;
    const restingNodes = await mobileSemantics(serial);
    const list = checkBounds(restingNodes, 'session-list');
    if (!list) throw new Error('The Session list is not laid out');
    const currentChip = checkBounds(restingNodes, chips.current);
    const nextChip = checkBounds(restingNodes, chips.next);
    if (!currentChip || !nextChip) throw new Error('The Project chips are not laid out');
    const restingChips = [
        await mobileRegionFingerprint(serial, currentChip),
        await mobileRegionFingerprint(serial, nextChip),
    ];
    const resting = await mobileRegionFingerprint(serial, list);
    // A list that changes on its own would make the held comparison below blame the gesture for it.
    if ((await mobileRegionFingerprint(serial, list)) !== resting)
        throw new Error('The Session list is not stable at rest');
    const width = list.right - list.left;
    const y = pagingY(restingNodes);
    const fromX = Math.floor(list.left + width * fromShare);
    const toX = Math.floor(list.left + width * toShare);
    const steps = 12;
    await adbShell(serial, [
        [
            `input motionevent DOWN ${fromX} ${y}`,
            ...Array.from(
                { length: steps },
                (_, index) =>
                    `input motionevent MOVE ${Math.round(fromX + ((toX - fromX) * (index + 1)) / steps)} ${y}`,
            ),
            'sleep 0.5',
        ].join('; '),
    ]);
    let held: string;
    let heldChips: string[];
    let heldNodes: MobileSemanticNode[];
    try {
        held = await mobileRegionFingerprint(serial, list);
        heldChips = [
            await mobileRegionFingerprint(serial, currentChip),
            await mobileRegionFingerprint(serial, nextChip),
        ];
        await capture(environment, 'holding-swipe', artifacts);
        // The held finger leaves the screen idle, so UIAutomator can read both pages mid-swipe. Rows repeat their check
        // ids on both pages and the dump keeps only the first, so each page is read by its own id.
        heldNodes = await mobileSemantics(serial);
    } finally {
        await adbShell(serial, ['input', 'motionevent', 'UP', String(toX), String(y)]);
    }
    if (held === resting) throw new Error('The Session list did not follow the finger mid-swipe');
    // Before the highlight followed the pager it stayed on the current chip until the release, leaving both chips as
    // they were at rest.
    if (heldChips[0] === restingChips[0])
        throw new Error('The highlight did not start leaving the current chip mid-swipe');
    if (heldChips[1] === restingChips[1])
        throw new Error('The highlight did not reach toward the next chip mid-swipe');
    // UIAutomator clips bounds to the screen: the current page ends short of the right edge, and the next page starts
    // past the left edge.
    const margin = width * 0.2;
    const current = checkBounds(heldNodes, pages.current);
    if (!current || current.right > list.right - margin)
        throw new Error('The current page did not move left with the finger');
    const next = checkBounds(heldNodes, pages.next);
    if (!next || next.left < list.left + margin)
        throw new Error('The next Project page did not slide in from the right edge');
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
 * tap opens the Session; a deliberate left swipe moves from All to the next Project chip, another left swipe at the
 * last chip stays put, and a right swipe returns to All. The list follows the finger while a swipe is held, with the
 * next Project's page sliding in and the filter highlight travelling toward its chip, and the release settles flush.
 * The header's icon buttons sit in the brand row above the Project chips.
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
        // A right drag on the open row closes it rather than paging.
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

        const projectChip = `project-filter-${fixture.allowedProjectId}`;
        await holdSwipeFollowingFinger(
            environment,
            artifacts,
            {
                current: 'session-page-project:all',
                next: `session-page-project:${fixture.allowedProjectId}`,
            },
            { current: 'project-filter-all', next: projectChip },
            0.8,
            0.2,
        );
        await waitForMobile(
            () => mobileSemantics(serial),
            (current) => isFilterSelected(current, projectChip),
        );
        // The settle lands exactly on the page, with no offset left over from the drag.
        const landedRow = checkBounds(await mobileSemantics(serial), `session-row-${target}`);
        if (landedRow?.left !== settled.left || landedRow.right !== settled.right)
            throw new Error('The Project page did not settle flush with the screen');
        await capture(environment, 'swiped-to-project', artifacts);
        // The phone only sees one Project, so it is the last chip and a further left swipe has nowhere to go.
        await swipeList(serial, 0.8, 0.2);
        // The switch is scheduled after release, so a wrong wrap-around would land late; watch for it.
        for (let sample = 0; sample < 3; sample += 1) {
            // eslint-disable-next-line no-await-in-loop -- each sample is a timed observation of the same screen.
            await pause(SETTLE_MS);
            // eslint-disable-next-line no-await-in-loop -- see above.
            if (!isFilterSelected(await mobileSemantics(serial), projectChip))
                throw new Error('A left swipe past the last Project left it');
        }
        await capture(environment, 'swiped-past-last', artifacts);
        await swipeList(serial, 0.2, 0.8);
        await waitForMobile(
            () => mobileSemantics(serial),
            (current) => isFilterSelected(current, 'project-filter-all'),
        );
        await capture(environment, 'swiped-back-to-all', artifacts);
        await finish(environment, artifacts, {
            driftingScroll: 'scrolled-without-switching-project',
            headerLayout: 'icon-buttons-in-brand-row-above-chips',
            heldSwipe: 'page-follows-finger-and-next-project-slides-in',
            heldSwipeHighlight: 'leaves-current-chip-and-reaches-next-chip',
            leftSwipe: 'all-to-project',
            leftSwipeAtLastProject: 'stayed',
            shortRowDrag: 'opened-archive-no-switch-right-drag-closed',
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
