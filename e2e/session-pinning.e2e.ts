import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

/**
 * Session ids of the rows the Pinned group currently renders, in the order it renders them.
 */
function pinnedOrder(page: Page): Promise<Array<string | undefined>> {
    return page
        .locator('.pinned-session-group .session-card')
        .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.sessionId));
}

test('pinning lifts Sessions from several Projects into one group that survives a relaunch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-pinning-e2e-'));
    const roots = ['alpha', 'beta'].map((name) => join(directory, name));
    await Promise.all(roots.map((root) => mkdir(root)));
    const options = {
        userDataDir: join(directory, 'profile'),
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    };
    let running = await launchCaxri(options);
    try {
        const page = () => running.page;
        await createProjectSession(page());
        const bootstrap = await pageRequest<{
            projects: Array<{ id: string; displayTitle: string }>;
            sessions: Array<{ id: string }>;
        }>(page(), 'app.bootstrap');
        const alpha = bootstrap.sessions[0];
        const alphaProject = bootstrap.projects[0];
        // The second Project consumes the next one-shot folder grant supplied through CAXRI_TEST_ROOT_PATHS.
        const betaRoot = await pageRequest<string | null>(page(), 'dialog.selectDirectory');
        if (betaRoot !== roots[1]) throw new Error('Second Project root fixture was not granted');
        const betaProject = await pageRequest<{ id: string; displayTitle: string }>(
            page(),
            'project.create',
            { rootPath: betaRoot },
        );
        const { session: beta } = await pageRequest<{ session: { id: string } }>(
            page(),
            'session.create',
            { projectId: betaProject.id, defaultAgent: null },
        );
        await pageRequest(page(), 'session.rename', { sessionId: alpha.id, displayTitle: 'Alpha' });
        await pageRequest(page(), 'session.rename', { sessionId: beta.id, displayTitle: 'Beta' });

        // No pinned Session yet, so the group renders nothing at all, not an empty heading.
        await expect(page().locator('.pinned-session-group')).toHaveCount(0);

        const projectRow = (projectId: string, sessionId: string) =>
            page()
                .locator(`.project-group[data-project-id="${projectId}"] .session-row`)
                .filter({ has: page().locator(`[data-session-id="${sessionId}"]`) });
        /**
         * The row's hover actions only become clickable under the pointer, which is what a user does.
         */
        const togglePin = async (row: ReturnType<typeof projectRow>, title: string) => {
            await row.hover();
            await row.getByRole('button', { name: `Pin ${title}` }).click();
        };

        await togglePin(projectRow(alphaProject.id, alpha.id), 'Alpha');
        await expect.poll(() => pinnedOrder(page())).toEqual([alpha.id]);
        // Pinning moves the Session: it leaves its own Project group and is listed once, under Pinned. The emptied
        // Project keeps its heading and falls back to the same "New Session" row an untouched empty Project shows.
        await expect(projectRow(alphaProject.id, alpha.id)).toHaveCount(0);
        await expect(
            page().locator(`.project-group[data-project-id="${alphaProject.id}"] .empty-project`),
        ).toBeVisible();
        // Pinned rows name their owning Project, which is the only thing telling two Projects' Sessions apart here.
        await expect(page().locator('.pinned-session-group .session-project').first()).toHaveText(
            alphaProject.displayTitle,
        );
        /**
         * The title and the Project name used to shrink in proportion to their own widths, so a long Project name
         * claimed the larger share of a crowded row and clipped the Session title down to a couple of characters, which
         * reads as the Project name covering the title rather than as either one being truncated. The Project name has
         * to give up all of its space before the title loses any, whatever the sidebar's current width is.
         */
        await pageRequest(page(), 'session.rename', {
            sessionId: alpha.id,
            displayTitle: 'Alpha Session title long enough to crowd its Project name',
        });
        await expect
            .poll(() =>
                page()
                    .locator('.pinned-session-group .session-card')
                    .first()
                    .evaluate((card) => {
                        const title = card.querySelector('.session-title');
                        const project = card.querySelector('.session-project');
                        if (!title || !project) return 'row is missing a part';
                        return title.scrollWidth > title.clientWidth + 1 &&
                            project.getBoundingClientRect().width > 0
                            ? 'the Project name kept width while the title was clipped'
                            : 'ok';
                    }),
            )
            .toBe('ok');
        await pageRequest(page(), 'session.rename', { sessionId: alpha.id, displayTitle: 'Alpha' });
        /**
         * The pin has no visible mark on the row, so the accessible description is the only thing that says the row is
         * pinned at all.
         */
        const describedBy = (selector: string) =>
            page().evaluate((cardSelector) => {
                const card = document.querySelector<HTMLElement>(cardSelector);
                const id = card?.getAttribute('aria-describedby');
                return id ? document.querySelector(`#${CSS.escape(id)}`)?.textContent : undefined;
            }, selector);
        await expect
            .poll(() => describedBy('.pinned-session-group .session-card'))
            .toMatch(/^In Pinned group\./);

        await togglePin(projectRow(betaProject.id, beta.id), 'Beta');
        await expect.poll(() => pinnedOrder(page())).toEqual([alpha.id, beta.id]);
        // The Pinned group sits above every Project.
        await expect(page().locator('[role="tree"] > *').first()).toHaveClass(
            /pinned-session-group/,
        );

        await running.page
            .locator('.project-list')
            .screenshot({ path: test.info().outputPath('session-pinned.png') });

        // Collapsing the group keeps the heading while hiding the rows. The heading shows no count digit; the
        // membership reaches assistive technology through its accessible name instead.
        const heading = page().locator('[data-row-id="pinned-sessions"]');
        await expect(heading).toHaveAttribute('aria-label', 'Pinned, 2 Sessions');
        await expect(heading).toHaveText('Pinned');
        await heading.click();
        await expect.poll(() => pinnedOrder(page())).toEqual([]);
        await expect(heading).toBeVisible();

        await running.app.close();
        running = await launchCaxri(options);
        // Both the membership and the collapsed state are durable.
        await expect(page().locator('[data-row-id="pinned-sessions"]')).toHaveAttribute(
            'aria-label',
            'Pinned, 2 Sessions',
        );
        await expect.poll(() => pinnedOrder(page())).toEqual([]);
        await page().locator('[data-row-id="pinned-sessions"]').click();
        await expect.poll(() => pinnedOrder(page())).toEqual([alpha.id, beta.id]);

        /**
         * Unpinning from the Pinned copy of the row removes it; emptying the group removes the heading too.
         */
        const pinnedRow = (sessionId: string) =>
            page()
                .locator('.pinned-session-group .session-row')
                .filter({ has: page().locator(`[data-session-id="${sessionId}"]`) });
        await togglePin(pinnedRow(alpha.id), 'Alpha');
        await expect.poll(() => pinnedOrder(page())).toEqual([beta.id]);
        await togglePin(pinnedRow(beta.id), 'Beta');
        await expect(page().locator('.pinned-session-group')).toHaveCount(0);
        // Unpinning is the other half of the move: each Session returns to the Project group it came from.
        await expect(projectRow(alphaProject.id, alpha.id)).toBeVisible();
        await expect(projectRow(betaProject.id, beta.id)).toBeVisible();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('the rename command finds a pinned Session in the group that actually holds it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-pinned-rename-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const bootstrap = await pageRequest<{ sessions: Array<{ id: string }> }>(
            page,
            'app.bootstrap',
        );
        const sessionId = bootstrap.sessions[0].id;
        await pageRequest(page, 'session.setPinned', { sessionId, pinned: true });
        await pageRequest(page, 'session.select', { sessionId });

        // Collapsed, so the row the rename editor replaces is not mounted when the command runs.
        const heading = page.locator('[data-row-id="pinned-sessions"]');
        await heading.click();
        await expect.poll(() => pinnedOrder(page)).toEqual([]);

        await page.keyboard.press('F2');

        /*
         * Pinning moves the Session out of its Project group, so the row the command has to reveal lives under Pinned
         * and nowhere else. Expanding the Project instead left the editor attached to a row that does not exist: the
         * command appeared to do nothing, and the phantom rename surfaced later as an unexplained editor.
         */
        const pinnedRow = page.locator(`[data-row-id="pinned-session:${sessionId}"]`);
        await expect(pinnedRow).toBeVisible();
        const input = pinnedRow.getByRole('textbox', { name: 'Rename Untitled' });
        await expect(input).toBeFocused();
        await input.fill('Pinned rename');
        await input.press('Enter');
        await expect(pinnedRow.locator('strong')).toHaveText('Pinned rename');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('an over-full Pinned group closes with a reveal row instead of burying every Project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-pinning-window-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const options = { userDataDir: join(directory, 'profile'), testRootPath: root };
    const running = await launchCaxri(options);
    try {
        const { page } = running;
        await createProjectSession(page);
        const bootstrap = await pageRequest<{
            projects: Array<{ id: string }>;
            sessions: Array<{ id: string }>;
        }>(page, 'app.bootstrap');
        const projectId = bootstrap.projects[0].id;
        const pinnedIds = [bootstrap.sessions[0].id];
        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- deterministic creation order decides the Pinned order
            const { session } = await pageRequest<{ session: { id: string } }>(
                page,
                'session.create',
                { projectId, defaultAgent: null },
            );
            pinnedIds.push(session.id);
        }
        for (const sessionId of pinnedIds)
            // eslint-disable-next-line no-await-in-loop -- pinned_order is append-only, so the calls must be ordered
            await pageRequest(page, 'session.setPinned', { sessionId, pinned: true });

        /*
         * The selected Session always renders, even from below the window, so selecting the first one is what leaves
         * the sixth genuinely hidden. Without this the window would show six rows and no reveal row at all.
         */
        await pageRequest(page, 'session.select', { sessionId: pinnedIds[0] });
        // Six pinned Sessions, a five-row window: the sixth is behind the reveal row rather than on screen.
        await expect.poll(() => pinnedOrder(page)).toEqual(pinnedIds.slice(0, 5));
        const reveal = page.locator('.pinned-session-group .session-reveal');
        await expect(reveal).toHaveAttribute('aria-label', 'Show 1 more pinned Session');
        await expect(reveal.locator('svg')).toHaveCount(0);
        await reveal.click();
        await expect.poll(() => pinnedOrder(page)).toEqual(pinnedIds);
        // The final reveal unmounts the row itself, so focus lands on the row above it, not on the document body.
        await expect(reveal).toHaveCount(0);
        await expect(
            page.locator(`.pinned-session-group [data-session-id="${pinnedIds[4]}"]`),
        ).toBeFocused();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('a row clicked, then pinned from its context menu, does not come back wearing the keyboard focus ring', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-pinning-focus-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const bootstrap = await pageRequest<{ sessions: Array<{ id: string }> }>(
            page,
            'app.bootstrap',
        );
        const sessionId = bootstrap.sessions[0].id;
        const card = page.locator(`.project-group [data-session-id="${sessionId}"]`);
        await card.click();
        /*
         * Any keypress after the click (the Cmd of a Cmd+Tab away and back is enough) switches Chromium's modality to
         * keyboard. The context menu is then opened without a renderer mouse event, which is what a right-click on an
         * inactive macOS window delivers, so the last modality is still the keyboard's when the pinned row is focused.
         */
        await page.keyboard.press('Shift');
        await card.evaluate((element) =>
            element.dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
            ),
        );
        await chooseContextMenuItem(running.app, 'Pin Session');

        const pinned = page.locator(`.pinned-session-group [data-session-id="${sessionId}"]`);
        await expect(pinned).toBeFocused();
        expect(await pinned.evaluate((element) => element.matches(':focus-visible'))).toBe(false);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
