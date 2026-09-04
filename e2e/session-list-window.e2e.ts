import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const SESSION_COUNT = 8;

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
        for (let index = 1; index < SESSION_COUNT; index += 1)
            // eslint-disable-next-line no-await-in-loop -- Session activity order follows creation order
            await pageRequest(running.page, 'session.create', { projectId, defaultAgent: null });

        const sessionCards = running.page.locator('.session-list .session-card');
        const reveal = running.page.getByRole('button', { name: /^Show \d+ more Sessions in / });
        await expect(sessionCards).toHaveCount(5);
        await expect(reveal).toHaveAccessibleName(/^Show 3 more Sessions in /);

        /**
         * Reveal from the keyboard: the row is the tree's last stop, and activating it must hand focus to the Session
         * row above before unmounting itself, or the tree's single Tab stop falls back to the document body.
         */
        await running.page.locator('.project-select').focus();
        await running.page.keyboard.press('End');
        await expect(reveal).toBeFocused();
        await running.page.keyboard.press('Enter');
        await expect(sessionCards).toHaveCount(SESSION_COUNT);
        await expect(reveal).toHaveCount(0);
        await expect(sessionCards.nth(4)).toBeFocused();

        /**
         * The oldest Session sits below the default window, which is exactly the case the selected-Session guarantee
         * protects: Session order is activity recency, so selecting it does not pull it to the top.
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
                `.session-row[aria-selected="true"] [data-session-id="${oldestSessionId}"]`,
            ),
        ).toBeVisible();
        await expect(running.page.locator('.session-list .session-card')).toHaveCount(
            SESSION_COUNT,
        );
        await expect(
            running.page.getByRole('button', { name: /^Show \d+ more Sessions in / }),
        ).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
