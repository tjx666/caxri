import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * Enough Sessions that the default 900×640 workbench still overflows `.project-list` after the reveal row is drained.
 * Sixteen fit; the window's `minHeight` is 640, so a `setBounds` shrink cannot help.
 */
const SESSION_COUNT = 28;

test('the Primary Sidebar Session list paints a top-edge shadow only after it has scrolled', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-sidebar-scroll-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const bootstrap = await pageRequest<{ projects: Array<{ id: string }> }>(
            page,
            'app.bootstrap',
        );
        const projectId = bootstrap.projects[0]?.id;
        if (!projectId) throw new Error('Project fixture was not created');
        let newestSessionId = '';
        for (let index = 1; index < SESSION_COUNT; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- Session activity order follows creation order
            const created = await pageRequest<{ session: { id: string } }>(page, 'session.create', {
                projectId,
                defaultAgent: null,
            });
            newestSessionId = created.session.id;
        }

        const sessionCards = page.locator('.session-list .session-card');
        const reveal = page.getByRole('treeitem', { name: /^Show \d+ more Sessions? in / });
        await expect(sessionCards.first()).toHaveAttribute('data-session-id', newestSessionId);
        await expect(reveal).toBeVisible();
        await reveal.click();
        await expect(sessionCards).toHaveCount(15);
        await reveal.click();
        await expect(sessionCards).toHaveCount(25);
        await reveal.click();
        await expect(sessionCards).toHaveCount(SESSION_COUNT);
        await expect(reveal).toHaveCount(0);

        const list = page.locator('.project-list');
        await expect
            .poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight))
            .toBe(true);
        await expect(list).toHaveAttribute('data-scrolled', 'false');
        expect(
            await list.evaluate(
                (element) => getComputedStyle(element, '::-webkit-scrollbar').width,
            ),
        ).toBe('8px');

        await list.evaluate((element) => {
            element.scrollTop = 48;
        });
        await expect(list).toHaveAttribute('data-scrolled', 'true');
        const scrolledShadow = await list.evaluate((element) => {
            const shell = element.parentElement;
            if (!shell) throw new Error('scroll-edge-shell is missing');
            return getComputedStyle(shell, '::after').boxShadow;
        });
        expect(scrolledShadow).not.toBe('none');
        await page.screenshot({
            path: test.info().outputPath('sidebar-scrolled-shadow.png'),
            mask: [page.locator('.xterm')],
        });

        await list.evaluate((element) => {
            element.scrollTop = 0;
        });
        await expect(list).toHaveAttribute('data-scrolled', 'false');
        expect(
            await list.evaluate((element) => {
                const shell = element.parentElement;
                if (!shell) throw new Error('scroll-edge-shell is missing');
                return getComputedStyle(shell, '::after').boxShadow;
            }),
        ).toBe('none');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
