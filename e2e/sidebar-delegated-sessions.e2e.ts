import type { BootstrapState } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import {
    HOST_PROJECT,
    launchDelegatedSessions,
    nestedGroup,
    nestedRow,
    openSessionFromPalette,
    runPaletteCommand,
    selectSession,
    sessionIdsIn,
    sorted,
    WORKER_PROJECT,
} from './support/delegated-sessions-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest, selectedSessionId, sessionCard } from './support/helpers.ts';

/**
 * The Project group's own Session list, which a nested Session must leave.
 */
function projectSessions(page: Page, title: string) {
    return page.getByRole('group', { name: `${title} Sessions` });
}

test('delegated Sessions nest under their host with their own Project name, a consult takes no row, and a failed delegation shows its red X', async () => {
    const testInfo = test.info();
    const fixture = await launchDelegatedSessions('caxri-sidebar-delegated');
    const { page } = fixture.running;
    try {
        const group = nestedGroup(page, 'Coordinator');
        await expect(group).toBeVisible();

        // The delegated Sessions left their own Project and sit one level under the host, in its Project's group.
        const nested = [fixture.reviewer, fixture.failed];
        await expect.poll(async () => sorted(await sessionIdsIn(group))).toEqual(sorted(nested));
        await expect(sessionCard(page, fixture.host)).toHaveAttribute('aria-level', '2');
        await expect(sessionCard(page, fixture.host)).toHaveAttribute('draggable', 'true');
        for (const sessionId of nested) {
            const row = nestedRow(page, sessionId);
            // eslint-disable-next-line no-await-in-loop -- one row at a time keeps the failing Session in the message.
            await expect(row).toHaveAttribute('aria-level', '3');
            // eslint-disable-next-line no-await-in-loop -- one row at a time keeps the failing Session in the message.
            await expect(row).toContainText(WORKER_PROJECT);
            // A nested Session follows its creator: it cannot be dragged or reordered.
            // eslint-disable-next-line no-await-in-loop -- one row at a time keeps the failing Session in the message.
            await expect(row).toHaveAttribute('draggable', 'false');
            // eslint-disable-next-line no-await-in-loop -- one row at a time keeps the failing Session in the message.
            await expect(
                projectSessions(page, HOST_PROJECT).locator(`[data-session-id="${sessionId}"]`),
            ).toHaveCount(1);
        }

        // The consult takes no row while its creator is listed; the hand-off, and the delegated Session the user took
        // over, stay ordinary rows in their own Project.
        await expect(sessionCard(page, fixture.consult)).toHaveCount(0);
        const workerSessions = projectSessions(page, WORKER_PROJECT);
        await expect
            .poll(async () => sorted(await sessionIdsIn(workerSessions)))
            .toEqual(sorted([fixture.handoff, fixture.takenOver]));
        await expect(sessionCard(page, fixture.handoff)).toHaveAttribute('aria-level', '2');
        await expect(sessionCard(page, fixture.takenOver)).toHaveAttribute('aria-level', '2');

        // Only the delegation that failed gets the red X: a task the user took over, or one with no record, does not.
        const failedGlyph = nestedRow(page, fixture.failed).getByRole('img', {
            name: 'Delegation failed',
        });
        await expect(failedGlyph).toBeVisible();
        await expect(failedGlyph).toHaveAttribute('data-session-status', 'failed');
        await expect(page.locator('[data-session-status="failed"]')).toHaveCount(1);
        await expect(sessionCard(page, fixture.takenOver).getByRole('img')).toHaveCount(0);
        await expect(nestedRow(page, fixture.reviewer).getByRole('img')).toHaveCount(0);
        await page
            .getByRole('tree')
            .first()
            .screenshot({
                path: testInfo.outputPath('sidebar-delegated-sessions.png'),
            });

        // Right from the host steps into its first nested row; Left from that row returns to the host.
        const firstNested = (await sessionIdsIn(group))[0];
        await sessionCard(page, fixture.host).focus();
        await page.keyboard.press('ArrowRight');
        await expect(nestedRow(page, firstNested)).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await expect(sessionCard(page, fixture.host)).toBeFocused();

        // Activity is a flat queue, but it hides the consult just as the Project tree does: its entry is the Chat that
        // asked for it (issue caxri#3881). The delegated Sessions are the user's work and stay listed.
        await page.locator('.primary-sidebar-activity-toggle').click();
        const activity = page.getByRole('tree', { name: 'Activity' });
        await expect(activity).toBeVisible();
        // The fan-out Sessions fill the Idle group's window, so reveal the rest before looking for a row in it.
        await activity.getByText(/^Show \d+ more$/).click();
        for (const sessionId of nested) {
            // eslint-disable-next-line no-await-in-loop -- one row at a time keeps the failing Session in the message.
            await expect(activity.locator(`[data-session-id="${sessionId}"]`)).not.toHaveCount(0);
        }
        await expect(activity.locator(`[data-session-id="${fixture.consult}"]`)).toHaveCount(0);
        await activity.screenshot({ path: testInfo.outputPath('activity-delegated-sessions.png') });
    } finally {
        await fixture.cleanup();
    }
});

test('previous and next Session and the palette reach nested Sessions, and a selected consult shows under its host', async () => {
    const fixture = await launchDelegatedSessions('caxri-sidebar-delegated-select');
    const { page } = fixture.running;
    try {
        await expect(nestedGroup(page, 'Coordinator')).toBeVisible();

        // Stepping through every Session reaches each nested Session once, including those behind the child window,
        // and never stops on the consult hidden under its creator.
        const everySession = [
            fixture.host,
            fixture.reviewer,
            fixture.failed,
            fixture.takenOver,
            fixture.handoff,
            fixture.fanOutHost,
            ...fixture.fanOutChildren,
        ];
        const visited: string[] = [fixture.host];
        for (let step = 1; step < everySession.length; step += 1) {
            // eslint-disable-next-line no-await-in-loop -- each step starts from the Session the last one selected.
            await runPaletteCommand(page, 'Select Next Session');
            // eslint-disable-next-line no-await-in-loop -- each step starts from the Session the last one selected.
            await expect.poll(() => selectedSessionId(page)).not.toBe(visited.at(-1));
            // eslint-disable-next-line no-await-in-loop -- each step starts from the Session the last one selected.
            const selected = await selectedSessionId(page);
            visited.push(selected);
            // A selected nested Session is always shown, even when the child window would fold it.
            // eslint-disable-next-line no-await-in-loop -- each step starts from the Session the last one selected.
            await expect(sessionCard(page, selected)).toBeVisible();
        }
        expect(visited).not.toContain(fixture.consult);
        expect(new Set(visited)).toEqual(new Set(everySession));
        // The host is followed by its own nested Sessions before anything else.
        const hostIndex = visited.indexOf(fixture.host);
        const hostedIds = [fixture.reviewer, fixture.failed];
        expect(sorted(visited.slice(hostIndex + 1, hostIndex + 1 + hostedIds.length))).toEqual(
            sorted(hostedIds),
        );

        // The palette still finds the hidden consult; selecting it shows it under its host so the selection is visible.
        await selectSession(page, fixture.host);
        await expect(sessionCard(page, fixture.consult)).toHaveCount(0);
        await openSessionFromPalette(page, 'Quick second opinion');
        await expect.poll(() => selectedSessionId(page)).toBe(fixture.consult);
        const consultRow = nestedRow(page, fixture.consult);
        await expect(consultRow).toHaveAttribute('aria-level', '3');
        await expect(consultRow).toHaveAttribute('aria-selected', 'true');
        await expect(nestedGroup(page, 'Coordinator').locator(consultRow)).toHaveCount(1);

        // Selecting anything else takes the consult off the tree again.
        await openSessionFromPalette(page, 'Migrate the fixtures');
        await expect.poll(() => selectedSessionId(page)).toBe(fixture.failed);
        await expect(nestedRow(page, fixture.failed)).toHaveAttribute('aria-selected', 'true');
        await expect(sessionCard(page, fixture.consult)).toHaveCount(0);
    } finally {
        await fixture.cleanup();
    }
});

test('more than three settled children fold behind Show more, and Show more adds the rest in place', async () => {
    const testInfo = test.info();
    const fixture = await launchDelegatedSessions('caxri-sidebar-delegated-fold');
    const { page } = fixture.running;
    try {
        const group = nestedGroup(page, 'Fan-out host');
        await expect(group).toBeVisible();
        // Five settled children, three shown: the newest three, then the reveal row for the other two.
        await expect(group.locator('.session-card')).toHaveCount(3);
        const reveal = group.getByRole('treeitem', {
            name: 'Show 2 more Sessions under Fan-out host',
        });
        await expect(reveal).toHaveAttribute('aria-level', '3');
        await expect(reveal).toHaveText('Show 2 more');
        await expect(sessionCard(page, fixture.fanOutHost)).toBeVisible();
        await page
            .getByRole('tree')
            .first()
            .screenshot({
                path: testInfo.outputPath('sidebar-delegated-folded.png'),
            });

        await reveal.click();
        await expect(group.locator('.session-card')).toHaveCount(5);
        await expect(reveal).toHaveCount(0);
        await expect
            .poll(async () => sorted(await sessionIdsIn(group)))
            .toEqual(sorted(fixture.fanOutChildren));
        // The other host's nested rows are untouched by this host's window.
        await expect(nestedGroup(page, 'Coordinator').locator('.session-card')).toHaveCount(2);
    } finally {
        await fixture.cleanup();
    }
});

test('archiving a nested Session or its host returns what remains to its own Project', async () => {
    const fixture = await launchDelegatedSessions('caxri-sidebar-delegated-archive');
    const { page } = fixture.running;
    try {
        const group = nestedGroup(page, 'Coordinator');
        await expect(group.locator('.session-card')).toHaveCount(2);

        // Delete on a nested row archives that Session, not its host.
        await nestedRow(page, fixture.reviewer).focus();
        await page.keyboard.press('Delete');
        await expect(sessionCard(page, fixture.reviewer)).toHaveCount(0);
        await expect(group.locator('.session-card')).toHaveCount(1);
        await expect(sessionCard(page, fixture.host)).toBeVisible();
        const afterRow = await pageRequest<BootstrapState>(page, 'app.bootstrap');
        expect(
            afterRow.sessions.find((session) => session.id === fixture.reviewer)?.archivedAt,
        ).toBeDefined();
        expect(
            afterRow.sessions.find((session) => session.id === fixture.host)?.archivedAt,
        ).toBeUndefined();

        // Archiving the host leaves no listed ancestor: the nested Sessions become ordinary rows in their own Project,
        // while the consult stays hidden: archiving its creator never gives a consult a row of its own.
        await pageRequest(page, 'session.archive', { sessionId: fixture.host });
        await expect(group).toHaveCount(0);
        const workerSessions = projectSessions(page, WORKER_PROJECT);
        const returned = [fixture.failed, fixture.takenOver, fixture.handoff];
        await expect
            .poll(async () => sorted(await sessionIdsIn(workerSessions)))
            .toEqual(sorted(returned));
        await expect(sessionCard(page, fixture.consult)).toHaveCount(0);
        for (const sessionId of returned) {
            // eslint-disable-next-line no-await-in-loop -- one row at a time keeps the failing Session in the message.
            await expect(sessionCard(page, sessionId)).toHaveAttribute('aria-level', '2');
        }
        // The other host keeps its three visible nested Sessions.
        await expect(page.locator('[data-nested-session]')).toHaveCount(3);
    } finally {
        await fixture.cleanup();
    }
});
