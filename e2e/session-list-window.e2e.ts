import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * Enough Sessions that the first reveal leaves the row on screen and the second one drains it, so both the
 * row-survives-a-step and the row-unmounts-on-the-final-step paths are exercised.
 */
const SESSION_COUNT = 16;

async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

test('the PrimarySidebar reveals older Sessions on demand and always renders the selected one', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-list-window-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const launchOptions = { userDataDir: userData, testRootPath: root };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page);
        const bootstrap = await pageRequest<{ projects: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        const projectId = bootstrap.projects[0]?.id;
        if (!projectId) throw new Error('Project fixture was not created');
        let newestSessionId = '';
        for (let index = 1; index < SESSION_COUNT; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- Session activity order follows creation order
            const created = await pageRequest<{ session: { id: string } }>(
                running.page,
                'session.create',
                { projectId, defaultAgent: null },
            );
            newestSessionId = created.session.id;
        }

        const sessionCards = running.page.locator('.session-list .session-card');
        const reveal = running.page.getByRole('treeitem', { name: /^Show \d+ more Sessions? in / });
        await expect(sessionCards).toHaveCount(5);
        /**
         * A `session.create` reply only proves Server stored it; the sidebar learns about it from a later refresh. The
         * reveal row cannot stand in for that wait; its label is capped at the reveal step, so it reads "Show 10 more"
         * whether 15 or 16 Sessions have arrived. Acting one Session early is what made this case intermittent: with 15
         * the very first reveal already drains the list, so the row hands focus to the Session above it before
         * unmounting and the reveal row is legitimately no longer focused. Sessions are ordered by activity recency, so
         * the newest one reaching the top row is the observable proof that every create has landed.
         */
        await expect(sessionCards.first()).toHaveAttribute('data-session-id', newestSessionId);
        await expect(reveal).toHaveAccessibleName(/^Show 10 more Sessions in /);
        await expect(reveal).toHaveText('Show more');
        // The row is not a collapsible branch, so it must not spend a twistie on a meaning it does not have.
        await expect(reveal.locator('svg')).toHaveCount(0);

        // The row is the tree's last stop, so End reaches it from the Project heading.
        await running.page.locator('.project-select').focus();
        await running.page.keyboard.press('End');
        await expect(reveal).toBeFocused();

        // A step that leaves Sessions hidden keeps the row, and the keyboard focus that is standing on it.
        await running.page.keyboard.press('Enter');
        await expect(sessionCards).toHaveCount(15);
        await expect(reveal).toHaveAccessibleName(/^Show 1 more Session in /);
        await expect(reveal).toBeFocused();

        /**
         * The final step unmounts the row, so it must hand focus to the Session row above it first; otherwise the
         * tree's single roving Tab stop falls back to the document body.
         */
        await running.page.keyboard.press('Enter');
        await expect(sessionCards).toHaveCount(SESSION_COUNT);
        await expect(reveal).toHaveCount(0);
        await expect(sessionCards.nth(14)).toBeFocused();

        /**
         * The oldest Session sits below the default window, which is exactly the case the selected-Session guarantee
         * protects: Session order is activity recency, so selecting it does not pull it to the top. The guarantee is
         * about that one row, so it is pinned to the end of the window rather than opened up to; the list stays five
         * rows plus the selection, and `Show N more` survives (issue #993).
         */
        const oldestSessionId = await sessionCards.last().getAttribute('data-session-id');
        if (!oldestSessionId) throw new Error('Session rows carry no id');

        // Revealing is deliberately per-Renderer-lifetime state, so a relaunch is back to the short list.
        await running.app.close();
        running = await launchCaxri(launchOptions);
        await expect(running.page.locator('.session-list .session-card')).toHaveCount(5);

        await pageRequest(running.page, 'session.select', { sessionId: oldestSessionId });
        await expect(
            running.page.locator(
                `.session-card[aria-selected="true"][data-session-id="${oldestSessionId}"]`,
            ),
        ).toBeVisible();
        await expect(running.page.locator('.session-list .session-card')).toHaveCount(6);
        await expect(
            running.page.getByRole('treeitem', { name: /^Show \d+ more Sessions? in / }),
        ).toHaveAccessibleName(/^Show 10 more Sessions in /);
        // The pinned row is last, below the five most recent Sessions rather than in its own activity position.
        await expect(running.page.locator('.session-list .session-card').last()).toHaveAttribute(
            'data-session-id',
            oldestSessionId,
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
