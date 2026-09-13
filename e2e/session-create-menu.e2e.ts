import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectRecord } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * A Project with no Sessions renders two controls that open the same Terminal choice: the heading's pencil and the "New
 * Session" row that stands in for the empty Session list. They used to share one menu, which anchored the popup to the
 * pencil no matter which control the user clicked (github.com/tjx666/caxri/issues/810).
 */
test('the empty-Project New Session row anchors the Terminal menu to itself', async () => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-create-session-menu-'));
    const directory = await realpath(created);
    const root = join(directory, 'empty-project');
    await mkdir(root);

    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
    });
    try {
        const pickedRoot = await pageRequest<string>(running.page, 'dialog.selectDirectory');
        const project = await pageRequest<ProjectRecord>(running.page, 'project.create', {
            rootPath: pickedRoot,
        });
        const group = running.page.locator(`.project-group[data-project-id="${project.id}"]`);
        const heading = group.locator('.project-heading');
        const pencil = heading.getByRole('button', {
            name: `New Session in ${project.displayTitle}`,
        });
        const emptyRow = group.locator('.empty-project');
        /**
         * Unnamed on purpose: Base UI labels a menu popup from its own trigger, so the two anchors produce two
         * different accessible names for one identical choice. Only one of them is ever open.
         */
        const menu = running.page.getByRole('menu');
        await expect(emptyRow).toBeVisible();

        await emptyRow.click();
        await expect(menu).toBeVisible();
        await expect(emptyRow).toHaveAttribute('aria-expanded', 'true');
        await expect(pencil).toHaveAttribute('aria-expanded', 'false');
        const rowChoices = await menu.getByRole('menuitem').allInnerTexts();
        expect(rowChoices).toContain('Start without a Terminal');

        await running.page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(emptyRow).toHaveAttribute('aria-expanded', 'false');

        // The pencil only becomes clickable while its heading is hovered or focused.
        await heading.hover();
        await pencil.click();
        await expect(menu).toBeVisible();
        await expect(pencil).toHaveAttribute('aria-expanded', 'true');
        await expect(emptyRow).toHaveAttribute('aria-expanded', 'false');
        expect(await menu.getByRole('menuitem').allInnerTexts()).toEqual(rowChoices);
    } finally {
        await running.app.close();
        await rm(created, { recursive: true, force: true });
    }
});
