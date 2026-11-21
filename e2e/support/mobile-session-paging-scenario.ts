import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MOBILE_DASHBOARD_GROUP_PAGE_SIZE } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import { adbShell, mobileSemantics, tapMobileCheckByBounds, waitForMobile } from './mobile-android';
import { runServerDatabase } from './run-server-database';
import type { MobileSessionPagingSeed } from './server-database/mobile-session-paging-seed';

/**
 * How many upward drags the list may take to bring a row on screen before the scenario gives up.
 */
const MAX_SCROLLS = 30;

type Fixture = Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;

/**
 * Launches the fixture over a profile seeded by `mobile-session-paging-seed`, then pairs the phone with the seeded
 * Projects once the newest backlog row shows.
 */
export async function pagingFixture(
    serial: string,
): Promise<{ fixture: Fixture; seed: MobileSessionPagingSeed }> {
    let seed: MobileSessionPagingSeed | undefined;
    const fixture = await createMobileAcceptanceFixture({
        // No Agent launches here; the mode only decides which fixture Sessions the allowed Project keeps.
        mode: 'launch-failure',
        serial,
        // The fixture keeps its profile beside the allowed root (`<testDirectory>/user-data`) and creates it at first
        // launch, so seeding it here writes the database Caxri then opens.
        seedProject: async (allowedRoot) => {
            const testDirectory = dirname(allowedRoot);
            const userData = join(testDirectory, 'user-data');
            const roots = {
                backlog: join(testDirectory, 'backlog-project'),
                recent: join(testDirectory, 'recent-project'),
                dormant: join(testDirectory, 'dormant-project'),
            };
            await Promise.all(
                [userData, ...Object.values(roots)].map((path) => mkdir(path, { recursive: true })),
            );
            seed = await runServerDatabase<MobileSessionPagingSeed>('mobile-session-paging-seed', {
                userData,
                roots,
            });
        },
    });
    if (!seed) {
        await fixture.stop();
        throw new Error('Session paging seed is unavailable');
    }
    await fixture.pair({
        projectIds: [seed.backlogProjectId, seed.recentProjectId, seed.dormantProjectId],
        readyCheckId: `session-row-${seed.attention[0]}`,
    });
    return { fixture, seed };
}

const isSelected = (nodes: MobileSemanticNode[], checkId: string): boolean =>
    nodes.some((node) => node.checkId === checkId && node.selected);

/**
 * Drags the Session list upward (`up`) or the Project chip strip toward its end (`left`) or start (`right`) until
 * `checkId` is on screen. Android semantics list only on-screen nodes, so a row or chip past the edge is absent until
 * it scrolls in.
 */
export async function dragUntil(
    serial: string,
    checkId: string,
    direction: 'left' | 'right' | 'up',
): Promise<MobileSemanticNode[]> {
    const containerId = direction === 'up' ? 'session-list' : 'session-project-filters';
    for (let attempt = 0; attempt < MAX_SCROLLS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each drag is observed on the screen the previous one left.
        const nodes = await mobileSemantics(serial);
        if (hasCheck(nodes, checkId)) return nodes;
        const box = checkBounds(nodes, containerId);
        if (!box) throw new Error(`${containerId} is not laid out`);
        const x = (share: number) => String(Math.floor(box.left + (box.right - box.left) * share));
        const y = (share: number) => String(Math.floor(box.top + (box.bottom - box.top) * share));
        const path = {
            left: [x(0.8), y(0.5), x(0.2), y(0.5)],
            right: [x(0.2), y(0.5), x(0.8), y(0.5)],
            up: [x(0.5), y(0.75), x(0.5), y(0.25)],
        }[direction];
        // eslint-disable-next-line no-await-in-loop -- see above.
        await adbShell(serial, ['input', 'swipe', ...path, '300']);
    }
    throw new Error(`${checkId} never scrolled into view`);
}

/**
 * `MOB-SESSION-LIST-PAGING-01`: a Project holds 70 finished Sessions in Needs attention, more than the phone dashboard
 * once carried in total, and one newer Idle Session. Filtered to that Project, the phone loads the first page of Needs
 * attention, still shows the new Session under Idle, and the group's `Show N more` row loads the next page from the
 * Server (issue #4072).
 */
export async function executeMobileSessionPagingScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { fixture, seed } = await pagingFixture(serial);
    try {
        const { attention, backlogProjectId, newIdle } = seed;
        const chip = `project-filter-${backlogProjectId}`;
        await tapMobileCheckByBounds(serial, chip);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => isSelected(nodes, chip) && hasCheck(nodes, `session-row-${attention[0]}`),
        );
        await capture(environment, 'backlog-first-page', artifacts);

        // Folding the backlog brings Idle up: the new Session is on the phone even behind 70 finished ones.
        await tapMobileCheckByBounds(serial, 'session-group-attention');
        const folded = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => hasCheck(nodes, `session-row-${newIdle}`),
            20_000,
        );
        const idleHeading = checkBounds(folded, 'session-group-idle');
        const idleRow = checkBounds(folded, `session-row-${newIdle}`);
        if (!idleHeading || !idleRow || idleRow.top < idleHeading.top)
            throw new Error('The new Session is not under the Idle heading');
        await capture(environment, 'idle-behind-backlog', artifacts);

        // Open the backlog again and load its next page.
        await tapMobileCheckByBounds(serial, 'session-group-attention');
        await waitForCheck(serial, `session-row-${attention[0]}`);
        const atReveal = await dragUntil(serial, 'session-group-reveal-attention', 'up');
        // The first page ends before the next Session: it has no row until the next page loads.
        if (
            attention
                .slice(MOBILE_DASHBOARD_GROUP_PAGE_SIZE)
                .some((id) => hasCheck(atReveal, `session-row-${id}`))
        )
            throw new Error('Needs attention showed rows past its first page before Show more');
        await capture(environment, 'backlog-show-more', artifacts);
        await tapMobileCheckByBounds(serial, 'session-group-reveal-attention');
        const nextPageRow = `session-row-${attention[MOBILE_DASHBOARD_GROUP_PAGE_SIZE]}`;
        await dragUntil(serial, nextPageRow, 'up');
        await capture(environment, 'backlog-next-page', artifacts);
        await finish(environment, artifacts, {
            idleRow: 'shown-under-idle',
            nextPage: 'loaded',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-SESSION-LIST-CHIPS-01`: of three paired Projects, the one last active a month ago has no chip; a trailing More
 * chip opens a sheet listing every Project, and choosing the dormant one there selects it and gives it a chip (issue
 * #4072).
 */
export async function executeMobileProjectChipsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { fixture, seed } = await pagingFixture(serial);
    try {
        const { backlogProjectId, dormantProjectId, dormantSessionId, recentProjectId } = seed;
        const start = await waitForCheck(serial, `project-filter-${backlogProjectId}`);
        // The strip runs past the screen edge; its trailing More chip shows once it is dragged to the end.
        const end = await dragUntil(serial, 'project-filter-more', 'left');
        for (const id of [backlogProjectId, recentProjectId])
            if (!hasCheck(start, `project-filter-${id}`) && !hasCheck(end, `project-filter-${id}`))
                throw new Error('An active Project has no chip');
        if ([start, end].some((nodes) => hasCheck(nodes, `project-filter-${dormantProjectId}`)))
            throw new Error('The dormant Project still has a chip');
        await capture(environment, 'chips-recent-only', artifacts);

        await tapMobileCheckByBounds(serial, 'project-filter-more');
        const sheet = await waitForCheck(serial, 'project-chooser-sheet');
        for (const id of [backlogProjectId, recentProjectId, dormantProjectId])
            if (!hasCheck(sheet, `project-chooser-${id}`))
                throw new Error('The More sheet does not list every Project');
        await capture(environment, 'more-sheet', artifacts);

        await tapMobileCheckByBounds(serial, `project-chooser-${dormantProjectId}`);
        const chosen = `project-filter-${dormantProjectId}`;
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, `session-row-${dormantSessionId}`) &&
                !hasCheck(nodes, 'project-chooser-sheet'),
        );
        // The strip still sits at its end, so a chip off screen lies toward its start.
        if (!isSelected(await dragUntil(serial, chosen, 'right'), chosen))
            throw new Error('The Project chosen under More has no selected chip');
        await capture(environment, 'dormant-chosen', artifacts);
        await finish(environment, artifacts, {
            dormantChip: 'hidden-until-chosen',
            moreSheet: 'lists-every-project',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
