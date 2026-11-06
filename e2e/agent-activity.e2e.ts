import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
} from './support/helpers.ts';
import {
    contextMenuLabels,
    dismissContextMenu,
    expectNoContextMenu,
} from './support/native-context-menu.ts';

const PROJECT_NAMES = ['alpha', 'beta', 'gamma'] as const;

async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

/**
 * The Activity queue's projection is unit-tested; what only a real launch can prove is that the toggle actually swaps
 * the Primary Side Bar's body, that the Renderer reads Sessions belonging to Projects other than the selected one, and
 * that selecting and acknowledging from this list reach the Server over IPC.
 */
test('Activity groups every Project’s Sessions attention-first and clears a reminder in place', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-activity-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const roots = PROJECT_NAMES.map((name) => join(testDirectory, name));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const launchOptions = {
        userDataDir: userData,
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page);
        const initial = await pageRequest<{
            projects: Array<{ id: string }>;
            selectedSessionId?: string;
        }>(running.page, 'app.bootstrap');
        if (!initial.selectedSessionId)
            throw new Error('The first Project fixture was not created');
        const sessions = new Map<string, string>([[PROJECT_NAMES[0], initial.selectedSessionId]]);
        const stale = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            {
                defaultAgent: null,
                projectId: initial.projects[0].id,
            },
        );
        sessions.set('stale', stale.session.id);
        const busy = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            {
                defaultAgent: null,
                projectId: initial.projects[0].id,
            },
        );
        sessions.set('busy', busy.session.id);

        for (const [index, name] of PROJECT_NAMES.slice(1).entries()) {
            // Test folder grants are consumed in the order supplied through CAXRI_TEST_ROOT_PATHS.
            // eslint-disable-next-line no-await-in-loop -- each one-shot grant must precede its Project creation
            const root = await pageRequest<string | null>(running.page, 'dialog.selectDirectory');
            if (root !== roots[index + 1]) throw new Error(`Unexpected ${name} Project root`);
            // eslint-disable-next-line no-await-in-loop -- the returned Project id owns the following Session
            const project = await pageRequest<{ id: string }>(running.page, 'project.create', {
                rootPath: root,
            });
            // eslint-disable-next-line no-await-in-loop -- Session identity is needed for the activity fixture
            const created = await pageRequest<{ session: { id: string } }>(
                running.page,
                'session.create',
                { projectId: project.id, defaultAgent: null },
            );
            sessions.set(name, created.session.id);
        }
        for (const [name, sessionId] of sessions) {
            // eslint-disable-next-line no-await-in-loop -- renames must land before the app closes
            await pageRequest(running.page, 'session.rename', {
                title: `${name} work`,
                sessionId,
            });
        }
        /**
         * The idle Session holds the selection so neither unread fixture is acknowledged by simply being on screen at
         * launch, which is what `useSessionAttentionAcknowledgement` does for the selected Session.
         */
        await pageRequest(running.page, 'session.select', { sessionId: sessions.get('gamma')! });
        await running.app.close();

        const database = new Database(join(userData, 'caxri.db'));
        const activityAt = Date.now();
        database.prepare('UPDATE sessions SET session_activity_at = ?').run(activityAt);
        database
            .prepare(
                'UPDATE projects SET title = ? WHERE id = (SELECT project_id FROM sessions WHERE id = ?)',
            )
            // Sized so that at the 180px minimum width the name plus its reserved 8px fade buffer (#1173) still fits
            // whole, while the time no longer fits beside it and has to drop out first.
            .run('web-client-portal', sessions.get('beta'));
        database
            .prepare(
                'UPDATE projects SET title = ? WHERE id = (SELECT project_id FROM sessions WHERE id = ?)',
            )
            .run('service-integration-platform-workspace', sessions.get('alpha'));
        database
            .prepare(
                `UPDATE sessions
                 SET attention_generation = 1, acknowledged_attention_generation = 0,
                     last_attention_kind = 'completed', agent_activity_state = 'completed'
                 WHERE id = ?`,
            )
            .run(sessions.get('alpha'));
        database
            .prepare(
                `UPDATE sessions
                 SET attention_generation = 1, acknowledged_attention_generation = 0,
                     last_attention_kind = 'waiting', agent_activity_state = 'waiting',
                     session_activity_at = ?
                 WHERE id = ?`,
            )
            .run(activityAt - 1_000, sessions.get('beta'));
        database
            .prepare(
                `UPDATE sessions
                 SET attention_generation = 1, acknowledged_attention_generation = 0,
                     last_attention_kind = 'completed', agent_activity_state = 'completed',
                     session_activity_at = ?
                 WHERE id = ?`,
            )
            .run(activityAt - 20 * 60_000, sessions.get('stale'));
        // Newer than every other row, so only the group order, not recency, can put it below a read result.
        database
            .prepare(
                "UPDATE sessions SET agent_activity_state = 'running', session_activity_at = ? WHERE id = ?",
            )
            .run(activityAt + 60_000, sessions.get('busy'));
        database.close();

        running = await launchCaxri(launchOptions);
        const page = running.page;
        const projectTree = page.getByRole('tree', { name: 'Primary Side Bar' });
        // Located by class rather than by name: the button's accessible name is the action it offers, so it changes
        // with the mode this test toggles.
        const activityToggle = page.locator('.primary-sidebar-activity-toggle');
        await expect(activityToggle).toHaveAttribute('aria-label', 'Show Activity');
        // Three Sessions have Pending Attention. There is no retention window: the oldest one still counts.
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('3');

        /*
         * Focus a tree row first, so the toggle below has something to lose. The body that leaves is unmounted, taking
         * the focused element with it, and the browser then drops focus onto `document.body`, which restarts the next
         * Tab from the top of the document. `chrome-focus-handoff.ts` exists for exactly this failure; the assertion
         * after the chord is what proves the new body swap is wired into it.
         */
        await projectTree.locator('[role="treeitem"][tabindex="0"]').first().focus();
        await expect
            .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
            .toBe('treeitem');

        await page.keyboard.press('Meta+Alt+u');
        await expect(activityToggle).toHaveAttribute('aria-label', 'Show Projects');
        await expect(activityToggle).toHaveAttribute('aria-pressed', 'true');
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const active = document.activeElement;
                    if (!active || active === document.body) return 'body';
                    return document.querySelector('.session-primary-sidebar')?.contains(active) ===
                        true
                        ? 'inside-primary-sidebar'
                        : 'elsewhere';
                }),
            )
            .toBe('inside-primary-sidebar');
        // The two bodies take turns in one column rather than stacking, so the tree has to be gone, not merely scrolled
        // past: a queue rendered below a still-mounted tree would satisfy every assertion under it.
        await expect(projectTree).toHaveCount(0);

        const tree = page.getByRole('tree', { name: 'Activity' });
        await expect
            .poll(() =>
                tree
                    .locator('.agent-activity-heading')
                    .evaluateAll((headings) =>
                        headings.map((heading) => heading.dataset.activityGroup),
                    ),
            )
            .toEqual(['attention', 'working', 'idle']);
        await expect
            .poll(() =>
                tree
                    .locator('.agent-activity-row[data-activity-group="attention"]')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            // A question blocks the Agent, so it ranks above the two finished results, which follow by recency.
            .toEqual([sessions.get('beta'), sessions.get('alpha'), sessions.get('stale')]);
        const betaRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('beta')}"]`,
        );
        await expect(betaRow).toContainText('beta work');
        // The Project cell specifically, not the row: the Session title contains the Project name too, so asserting on
        // the whole row would pass even if the flat list never printed which repository a row belongs to.
        await expect(betaRow.locator('.agent-activity-project')).toHaveText('web-client-portal');
        /*
         * Rows carry no state glyph: the group heading names the state. An attention row leads with a reserved slot
         * holding the unread dot, and (excerpts are off by default) a waiting row says so on its metadata line.
         */
        await expect(tree.locator('.agent-activity-glyph')).toHaveCount(0);
        await expect(betaRow.locator('.agent-activity-lead')).toBeAttached();
        await expect(betaRow.locator('.agent-activity-unread-dot')).toHaveAttribute(
            'data-activity-unread',
            'waiting',
        );
        await expect(betaRow.locator('.agent-activity-mark')).toHaveText('?');
        await expect(betaRow.locator('.agent-activity-note')).toHaveText('Waiting for you');
        await expect(betaRow).toHaveAttribute('aria-keyshortcuts', /Delete Backspace/u);
        // A finished result has no question, so its metadata line carries no state phrase.
        const alphaRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('alpha')}"]`,
        );
        await expect(alphaRow.locator('.agent-activity-note')).toHaveCount(0);
        await expect(alphaRow.locator('.agent-activity-unread-dot')).toHaveAttribute(
            'data-activity-unread',
            'completed',
        );
        const idleRowIds = () =>
            tree
                .locator('.agent-activity-row[data-activity-group="idle"]')
                .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId));
        /*
         * Rendered, not merely present in the DOM. `toHaveText` above reads the DOM, so it passes on a cell CSS has
         * truncated to zero width, which is exactly what the Primary Side Bar's 230px default did to this row while
         * the state was still a phrase: every unread row printed "· Waiting for you · " with no Project at all. A flat
         * cross-Project queue that cannot name the Project is the one thing this list must never do.
         */
        const divider = page.getByRole('separator', {
            name: 'Resize Primary Side Bar',
            exact: true,
        });
        const dividerBounds = await divider.boundingBox();
        if (!dividerBounds) throw new Error('The sidebar divider is not visible');
        const rowHeight = await betaRow.evaluate((row) => row.getBoundingClientRect().height);
        await page.mouse.move(dividerBounds.x + dividerBounds.width / 2, dividerBounds.y + 40);
        await page.mouse.down();
        await page.mouse.move(dividerBounds.x - 300, dividerBounds.y + 40);
        await page.mouse.up();
        await expect(divider).toHaveAttribute('aria-valuenow', '180');
        await expect
            .poll(() =>
                betaRow
                    .locator('.agent-activity-project')
                    .evaluate((cell) => cell.scrollWidth <= cell.clientWidth),
            )
            .toBe(true);
        /*
         * A short, un-clipped Project name must render inside a box wider than its own text, not exactly the width of
         * the text: `.overflow-fade`'s mask fades the box's last 8px unconditionally, so an exactly content-sized box
         * would fade real characters even though nothing is actually being cut off. Measure the text's own right edge
         * against the box's: `scrollWidth` counts padding too, so it cannot see the reserved buffer (issue #1173).
         */
        expect(
            await betaRow.locator('.agent-activity-project').evaluate((cell) => {
                const text = document.createRange();
                text.selectNodeContents(cell);
                return cell.getBoundingClientRect().right - text.getBoundingClientRect().right;
            }),
        ).toBeGreaterThanOrEqual(8);
        expect(await betaRow.evaluate((row) => row.getBoundingClientRect().height)).toBe(rowHeight);
        // The waiting mark leads the clipped line, so the state survives a width too narrow for its phrase.
        expect(
            await betaRow.locator('.agent-activity-mark').evaluate((mark) => {
                const metadata = mark.closest('.agent-activity-metadata')!;
                return (
                    mark.getBoundingClientRect().bottom <= metadata.getBoundingClientRect().bottom
                );
            }),
        ).toBe(true);
        expect(
            await betaRow.locator('.agent-activity-time').evaluate((time) => {
                const metadata = time.parentElement!;
                return time.getBoundingClientRect().top >= metadata.getBoundingClientRect().bottom;
            }),
        ).toBe(true);
        await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
        /*
         * The row wears the Project tree's Session hover card, which names the full Project, the only place a
         * truncated one can still be read in full, now that the row has no tooltip competing with the card.
         */
        await betaRow.locator('.agent-activity-project').hover();
        await expect(page.locator('.session-activity-card')).toContainText('web-client-portal');
        await page.screenshot({
            path: test.info().outputPath('activity-narrow-project.png'),
            mask: [page.locator('.xterm')],
        });
        const alphaProject = alphaRow.locator('.agent-activity-project');
        await expect(alphaProject).toHaveText('service-integration-platform-workspace');
        expect(await alphaProject.evaluate((cell) => cell.scrollWidth > cell.clientWidth)).toBe(
            true,
        );
        await alphaProject.hover();
        await expect(page.locator('.session-activity-card')).toContainText(
            'service-integration-platform-workspace',
        );
        await page.screenshot({
            path: test.info().outputPath('activity-project-tooltip.png'),
            mask: [page.locator('.xterm')],
        });
        await divider.dblclick();
        await expect(divider).toHaveAttribute('aria-valuenow', '230');
        /*
         * At the default width the mark and the Project still lead the line; the phrase and the time follow only where
         * the line has room, so a long Project never loses width to them.
         */
        expect(
            await betaRow.locator('.agent-activity-mark').evaluate((mark) => {
                const metadata = mark.closest('.agent-activity-metadata')!;
                return (
                    mark.getBoundingClientRect().bottom <= metadata.getBoundingClientRect().bottom
                );
            }),
        ).toBe(true);
        await expect
            .poll(() =>
                betaRow
                    .locator('.agent-activity-project')
                    .evaluate((cell) => cell.scrollWidth <= cell.clientWidth),
            )
            .toBe(true);
        await page.screenshot({
            path: test.info().outputPath('activity-default-width.png'),
            mask: [page.locator('.xterm')],
        });
        /*
         * The same context menu as a Project tree row, adapted to the queue: a row with Pending Attention offers Mark
         * as Done (there is no Mark as Read here), and Rename opens the Activity row's inline editor.
         */
        await betaRow.click({ button: 'right' });
        const rowMenuLabels = await contextMenuLabels(running.app);
        expect(rowMenuLabels).toEqual(
            expect.arrayContaining(['Mark as Done', 'Archive', 'Rename']),
        );
        expect(rowMenuLabels).not.toContain('Mark as Read');
        await dismissContextMenu(running.app);
        await expectNoContextMenu(running.app);
        const staleRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('stale')}"]`,
        );
        // The first `.overflow-fade` in a row is its title; the Project cell that follows shares the class.
        const staleTitle = staleRow.locator('.overflow-fade').first();
        const staleTopBeforeSelection = await staleRow.evaluate(
            (row) => row.getBoundingClientRect().top,
        );
        await expect(staleTitle).toHaveCSS('font-weight', '500');
        await staleRow.click();
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('stale'));
        // Reading is not resolving: the Session stays in Needs attention and in the badge.
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('3');
        await expect(staleRow).toHaveAttribute('data-activity-group', 'attention');
        await expect(staleRow).toHaveAttribute('aria-selected', 'true');
        await expect(staleRow.locator('.agent-activity-unread-dot')).toHaveCount(0);
        await expect(staleTitle).not.toHaveCSS('font-weight', '500');
        const attentionHeading = tree.locator(
            '.agent-activity-heading[data-activity-group="attention"]',
        );
        await expect(attentionHeading.locator('span').first()).toHaveText('Needs attention');
        await expect(attentionHeading.locator('span[aria-hidden="true"]')).toHaveText('3');
        // The selected row offers its Mark as Done check in the slot the unread dot left.
        await expect(page.getByRole('button', { name: 'Mark stale work as Done' })).toBeVisible();
        expect(await staleRow.evaluate((row) => row.getBoundingClientRect().top)).toBe(
            staleTopBeforeSelection,
        );
        await page.mouse.move(800, 700);
        await expect(page.locator('.session-activity-card')).toHaveCount(0);
        await page.screenshot({
            path: test.info().outputPath('activity-viewed-stale.png'),
            mask: [page.locator('.xterm')],
        });
        // Moving the selection away does not release the row either.
        await tree
            .locator(`.agent-activity-row[data-session-id="${sessions.get('gamma')}"]`)
            .click();
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('gamma'));
        await expect(staleRow).toHaveAttribute('data-activity-group', 'attention');
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('3');

        // The check button resolves the row without opening it, and the Session lands at the top of Idle.
        await alphaRow.hover();
        const markAlphaDone = page.getByRole('button', { name: 'Mark alpha work as Done' });
        await expect(markAlphaDone).toBeVisible();
        // Wait out the fade-in so the screenshot shows the check rather than a half-transparent frame.
        await expect(markAlphaDone).toHaveCSS('opacity', '1');
        await expect(alphaRow.locator('.agent-activity-unread-dot')).toHaveCSS('opacity', '0');
        await page.screenshot({
            path: test.info().outputPath('activity-mark-done-hover.png'),
            mask: [page.locator('.xterm')],
        });
        await markAlphaDone.click();
        await expect(alphaRow).toHaveAttribute('data-activity-group', 'idle');
        expect(await selectedSessionId(page)).toBe(sessions.get('gamma'));
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('2');
        await expect(attentionHeading.locator('span[aria-hidden="true"]')).toHaveText('2');
        await expect.poll(idleRowIds).toEqual([sessions.get('alpha'), sessions.get('gamma')]);
        await expect
            .poll(() =>
                tree
                    .locator('.agent-activity-heading')
                    .evaluateAll((headings) =>
                        headings.map((heading) => heading.dataset.activityGroup),
                    ),
            )
            .toEqual(['attention', 'working', 'idle']);
        await page.mouse.move(800, 700);
        await page.screenshot({
            path: test.info().outputPath('activity-marked-done-in-idle.png'),
            mask: [page.locator('.xterm')],
        });

        // Meta+Shift+N walks Needs attention; opening the Session reads it but keeps it in the queue.
        const betaTopBeforeSelection = await betaRow.evaluate(
            (row) => row.getBoundingClientRect().top,
        );
        await page.mouse.move(600, 400);
        await page.keyboard.press('Meta+Shift+n');
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('beta'));
        await expect(betaRow).toHaveAttribute('data-activity-group', 'attention');
        await expect(betaRow.locator('.agent-activity-unread-dot')).toHaveCount(0);
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('2');
        await expect(attentionHeading.locator('span[aria-hidden="true"]')).toHaveText('2');
        expect(await betaRow.evaluate((row) => row.getBoundingClientRect().top)).toBe(
            betaTopBeforeSelection,
        );

        // Delete on a focused row is Mark as Done too; the newest resolution sits above the earlier one.
        await staleRow.focus();
        await page.keyboard.press('Delete');
        await expect(staleRow).toHaveAttribute('data-activity-group', 'idle');
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('1');
        await expect(attentionHeading.locator('span[aria-hidden="true"]')).toHaveText('1');
        await expect
            .poll(idleRowIds)
            .toEqual([sessions.get('stale'), sessions.get('alpha'), sessions.get('gamma')]);
        // A resolved row has nothing left to mark.
        await expect(staleRow).not.toHaveAttribute('aria-keyshortcuts', /Delete/u);
        await page.mouse.move(800, 700);
        await page.screenshot({
            path: test.info().outputPath('activity-delete-marks-done.png'),
            mask: [page.locator('.xterm')],
        });

        await alphaRow.click();
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('alpha'));
        // Selecting from the queue keeps the queue: the user is walking it, and a click that threw them back to the
        // tree would cost them their place after every single row.
        await expect(tree).toBeVisible();

        /*
         * Activity replaces the Project tree, so it carries its own New Session entry. It targets the selected
         * Session's Project, and its chevron's list re-targets another Project without closing.
         */
        const newSessionRow = page.locator('.agent-activity-new-session');
        const newSessionOptions = page.locator('.agent-activity-new-session-options');
        await expect(newSessionRow).toContainText('service-integration-platform-workspace');
        await newSessionOptions.click();
        const creationMenu = page.getByRole('menu');
        await expect(creationMenu.getByRole('menuitemradio')).toHaveCount(PROJECT_NAMES.length);
        await creationMenu.getByRole('menuitemradio', { name: 'web-client-portal' }).click();
        await expect(creationMenu).toBeVisible();
        await expect(newSessionRow).toContainText('web-client-portal');
        const sessionCountBefore = (
            await pageRequest<{ sessions: unknown[] }>(page, 'app.bootstrap')
        ).sessions.length;
        await creationMenu.getByRole('menuitem', { name: 'Empty Session' }).click();
        await expect
            .poll(
                async () =>
                    (await pageRequest<{ sessions: unknown[] }>(page, 'app.bootstrap')).sessions
                        .length,
            )
            .toBe(sessionCountBefore + 1);
        await expect(creationMenu).toHaveCount(0);

        // Once an Agent was picked from a list, the row's own press repeats it in the targeted Project in one click.
        await newSessionOptions.click();
        await creationMenu.getByRole('menuitem', { name: /^Shell/ }).click();
        await expect(creationMenu).toHaveCount(0);
        const sessionCountBeforePress = (
            await pageRequest<{ sessions: unknown[] }>(page, 'app.bootstrap')
        ).sessions.length;
        await newSessionRow.hover();
        await expect(page.locator('.tooltip-popup')).toContainText('New Shell');
        await expect(newSessionRow).toHaveAccessibleName(/ in web-client-portal$/);
        await newSessionRow.click();
        await expect
            .poll(
                async () =>
                    (await pageRequest<{ sessions: unknown[] }>(page, 'app.bootstrap')).sessions
                        .length,
            )
            .toBe(sessionCountBeforePress + 1);
        await expect(creationMenu).toHaveCount(0);

        // Every group heading is a disclosure: collapsing one keeps its heading and count, and drops its rows.
        const idleHeading = tree.locator('.agent-activity-heading[data-activity-group="idle"]');
        await idleHeading.click();
        await expect(idleHeading).toHaveAttribute('aria-expanded', 'false');
        await expect(tree.locator('.agent-activity-row[data-activity-group="idle"]')).toHaveCount(
            0,
        );
        await page.screenshot({
            path: test.info().outputPath('activity-new-session-collapsed-group.png'),
            mask: [page.locator('.xterm')],
        });
        await idleHeading.press('ArrowRight');
        await expect(idleHeading).toHaveAttribute('aria-expanded', 'true');

        await activityToggle.click();
        await expect(activityToggle).toHaveAttribute('aria-pressed', 'false');
        await expect(projectTree).toBeVisible();
        await expect(page.getByRole('tree', { name: 'Activity' })).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
