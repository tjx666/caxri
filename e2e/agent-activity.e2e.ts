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
                displayTitle: `${name} work`,
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
        database.prepare('UPDATE sessions SET last_session_activity_at = ?').run(activityAt);
        database
            .prepare(
                'UPDATE projects SET display_title = ? WHERE id = (SELECT project_id FROM sessions WHERE id = ?)',
            )
            // Sized so that at the 180px minimum width the name plus its reserved 8px fade buffer (#1173) still fits
            // whole, while the time no longer fits beside it and has to drop out first.
            .run('web-client-portal', sessions.get('beta'));
        database
            .prepare(
                'UPDATE projects SET display_title = ? WHERE id = (SELECT project_id FROM sessions WHERE id = ?)',
            )
            .run('service-integration-platform-workspace', sessions.get('alpha'));
        database
            .prepare(
                `UPDATE sessions
                 SET attention_epoch = 1, read_attention_epoch = 0,
                     last_attention_kind = 'completed', last_activity_state = 'completed'
                 WHERE id = ?`,
            )
            .run(sessions.get('alpha'));
        database
            .prepare(
                `UPDATE sessions
                 SET attention_epoch = 1, read_attention_epoch = 0,
                     last_attention_kind = 'waiting', last_activity_state = 'waiting',
                     last_session_activity_at = ?
                 WHERE id = ?`,
            )
            .run(activityAt - 1_000, sessions.get('beta'));
        database
            .prepare(
                `UPDATE sessions
                 SET attention_epoch = 1, read_attention_epoch = 0,
                     last_attention_kind = 'completed', last_activity_state = 'completed',
                     last_session_activity_at = ?
                 WHERE id = ?`,
            )
            .run(activityAt - 20 * 60_000, sessions.get('stale'));
        database.close();

        running = await launchCaxri(launchOptions);
        const page = running.page;
        const projectTree = page.getByRole('tree', { name: 'Primary Side Bar' });
        // Located by class rather than by name: the button's accessible name is the action it offers, so it changes
        // with the mode this test toggles.
        const activityToggle = page.locator('.primary-sidebar-activity-toggle');
        await expect(activityToggle).toHaveAttribute('aria-label', 'Show Activity');
        // Three unread Sessions are waiting, including a completed turn older than the retention window.
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('3');

        /*
         * Focus a tree row first, so the toggle below has something to lose. The body that leaves is unmounted, taking
         * the focused element with it, and the browser then drops focus onto `document.body` — which restarts the next
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
            .toEqual(['attention', 'idle']);
        await expect
            .poll(() =>
                tree
                    .locator('.agent-activity-row[data-activity-group="attention"]')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            .toEqual([sessions.get('alpha'), sessions.get('beta'), sessions.get('stale')]);
        const betaRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('beta')}"]`,
        );
        await expect(betaRow).toContainText('beta work');
        // The Project cell specifically, not the row: the Session title contains the Project name too, so asserting on
        // the whole row would pass even if the flat list never printed which repository a row belongs to.
        await expect(betaRow.locator('.agent-activity-project')).toHaveText('web-client-portal');
        /*
         * The state is a glyph, not a phrase, so the words only survive as its accessible name. Assert both halves:
         * the shape that identifies the state visually, and the label a screen reader is left with once the phrase is
         * gone from the row.
         */
        const betaGlyph = betaRow.locator('.agent-activity-glyph');
        await expect(betaGlyph).toHaveAttribute('data-activity-glyph', 'question');
        await expect(betaGlyph).toHaveAttribute('aria-label', 'Waiting for you');
        // And nowhere else: a row that still printed its state would make its own heading redundant.
        await expect(betaRow).not.toContainText('Waiting for you');
        /*
         * Rendered, not merely present in the DOM. `toHaveText` above reads the DOM, so it passes on a cell CSS has
         * truncated to zero width — which is exactly what the Primary Side Bar's 230px default did to this row while
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
        expect(
            await betaRow.locator('.agent-activity-time').evaluate((time) => {
                const metadata = time.parentElement!;
                return time.getBoundingClientRect().top >= metadata.getBoundingClientRect().bottom;
            }),
        ).toBe(true);
        await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
        /*
         * The row wears the Project tree's Session hover card, which names the full Project — the only place a
         * truncated one can still be read in full, now that the row has no tooltip competing with the card.
         */
        await betaRow.locator('.agent-activity-project').hover();
        await expect(page.locator('.session-activity-card')).toContainText('web-client-portal');
        await page.screenshot({
            path: test.info().outputPath('activity-narrow-project.png'),
            mask: [page.locator('.xterm')],
        });
        const alphaRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('alpha')}"]`,
        );
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
        expect(
            await betaRow
                .locator('.agent-activity-time')
                .evaluate(
                    (time) =>
                        time.getBoundingClientRect().bottom <=
                        time.parentElement!.getBoundingClientRect().bottom,
                ),
        ).toBe(true);
        await page.screenshot({
            path: test.info().outputPath('activity-default-width.png'),
            mask: [page.locator('.xterm')],
        });
        /*
         * The same context menu as a Project tree row, adapted to the queue: an unread row offers Mark as Read, and
         * Rename opens the Activity row's inline editor.
         */
        await betaRow.click({ button: 'right' });
        const rowMenuLabels = await contextMenuLabels(running.app);
        expect(rowMenuLabels).toEqual(
            expect.arrayContaining(['Mark as Read', 'Archive', 'Rename']),
        );
        await dismissContextMenu(running.app);
        await expectNoContextMenu(running.app);
        const staleRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('stale')}"]`,
        );
        const staleTopBeforeSelection = await staleRow.evaluate(
            (row) => row.getBoundingClientRect().top,
        );
        await staleRow.click();
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('stale'));
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveText('2');
        await expect(staleRow).toHaveAttribute('data-activity-group', 'attention');
        await expect(staleRow).toHaveAttribute('aria-selected', 'true');
        await expect(staleRow).toHaveAttribute('aria-description', 'Viewed and read');
        await expect(staleRow.locator('.agent-activity-glyph')).toHaveClass(/text-muted/);
        const attentionHeading = tree.locator(
            '.agent-activity-heading[data-activity-group="attention"]',
        );
        await expect(attentionHeading.locator('span').first()).toHaveText('Needs attention');
        await expect(attentionHeading.locator('span[aria-hidden="true"]')).toHaveText('2');
        await expect(staleRow.getByRole('button', { name: 'Mark stale work as read' })).toHaveCount(
            0,
        );
        expect(await staleRow.evaluate((row) => row.getBoundingClientRect().top)).toBe(
            staleTopBeforeSelection,
        );
        await page.mouse.move(800, 700);
        await expect(page.locator('.session-activity-card')).toHaveCount(0);
        await page.screenshot({
            path: test.info().outputPath('activity-viewed-stale.png'),
            mask: [page.locator('.xterm')],
        });
        await tree
            .locator(`.agent-activity-row[data-session-id="${sessions.get('gamma')}"]`)
            .click();
        await expect(staleRow).toHaveCount(0);

        await alphaRow.hover();
        const markAlphaRead = page.getByRole('button', { name: 'Mark alpha work as read' });
        await expect(markAlphaRead).toBeVisible();
        // Wait out the fade-in so the screenshot shows the chip rather than a half-transparent frame.
        await expect(markAlphaRead).toHaveCSS('opacity', '1');
        /*
         * The row's trailing actions are centered on the whole two-line row rather than pinned beside the title, so
         * they read as belonging to the Session instead of floating in its top-right corner.
         */
        const [alphaRowBox, markAlphaReadBox] = await Promise.all([
            alphaRow.boundingBox(),
            markAlphaRead.boundingBox(),
        ]);
        expect(
            Math.abs(
                alphaRowBox!.y +
                    alphaRowBox!.height / 2 -
                    (markAlphaReadBox!.y + markAlphaReadBox!.height / 2),
            ),
        ).toBeLessThanOrEqual(1);
        await page.screenshot({
            path: test.info().outputPath('activity-mark-read-hover.png'),
            mask: [page.locator('.xterm')],
        });
        await markAlphaRead.click();
        await expect(alphaRow).toHaveAttribute('data-activity-group', 'finished');
        expect(await selectedSessionId(page)).toBe(sessions.get('gamma'));

        const betaTopBeforeSelection = await betaRow.evaluate(
            (row) => row.getBoundingClientRect().top,
        );
        await page.mouse.move(600, 400);
        await page.keyboard.press('Meta+Shift+n');
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('beta'));
        await expect(activityToggle.locator('.primary-sidebar-activity-badge')).toHaveCount(0);
        await expect(betaRow).toHaveAttribute('data-activity-group', 'attention');
        await expect(attentionHeading.locator('span').first()).toHaveText('Viewing');
        await expect(attentionHeading.locator('span[aria-hidden="true"]')).toHaveCount(0);
        expect(await betaRow.evaluate((row) => row.getBoundingClientRect().top)).toBe(
            betaTopBeforeSelection,
        );

        await alphaRow.click();
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('alpha'));
        // Selecting from the queue keeps the queue: the user is walking it, and a click that threw them back to the
        // tree would cost them their place after every single row.
        await expect(tree).toBeVisible();

        await activityToggle.click();
        await expect(activityToggle).toHaveAttribute('aria-pressed', 'false');
        await expect(projectTree).toBeVisible();
        await expect(page.getByRole('tree', { name: 'Activity' })).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
