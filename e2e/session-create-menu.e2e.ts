import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProjectRecord } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import type { RunningCaxri } from './support/helpers.ts';
import { chooseTerminalFromCreateMenu, launchCaxri, pageRequest } from './support/helpers.ts';

interface EmptyProjectFixture {
    directory: string;
    project: ProjectRecord;
    running: RunningCaxri;
}

/**
 * Launches Caxri holding exactly one Project and no Sessions, which is the only state that renders the "New Session"
 * row. `project.create` is used directly because the Add Project flow creates a Session along with the Project.
 */
async function emptyProject(): Promise<EmptyProjectFixture> {
    const created = await mkdtemp(join(tmpdir(), 'caxri-create-session-menu-'));
    const directory = await realpath(created);
    const root = join(directory, 'empty-project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
    });
    const pickedRoot = await pageRequest<string>(running.page, 'dialog.selectDirectory');
    const project = await pageRequest<ProjectRecord>(running.page, 'project.create', {
        rootPath: pickedRoot,
    });
    return { directory, project, running };
}

/**
 * A Project with no Sessions renders two controls that open the same Terminal choice: the heading's pencil and the "New
 * Session" row that stands in for the empty Session list. They used to share one menu, which anchored the popup to the
 * pencil no matter which control the user clicked (github.com/tjx666/caxri/issues/810).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the empty-Project New Session row anchors the Terminal menu to itself', async ({}, testInfo) => {
    const { directory, project, running } = await emptyProject();
    try {
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
        await pencil.hover();

        // Hovering the pencil opens the list on its own, and a press while it is open keeps it open.
        await expect(menu).toBeVisible();
        await expect(pencil).toHaveAttribute('aria-expanded', 'true');
        await running.page.screenshot({ path: testInfo.outputPath('heading-hover-menu.png') });
        await pencil.click();
        await expect(menu).toBeVisible();
        await expect(pencil).toHaveAttribute('aria-expanded', 'true');
        await expect(emptyRow).toHaveAttribute('aria-expanded', 'false');
        expect(await menu.getByRole('menuitem').allInnerTexts()).toEqual(rowChoices);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * The same row as a tree row. It used to be mouse-only: hard-wired `tabIndex={-1}` and missing from the
 * PrimarySidebar's flattened row order, so arrow keys walked straight past it to the next Project
 * (github.com/tjx666/caxri/issues/608).
 */
test('arrow keys reach the empty-Project New Session row and follow the Session it creates', async () => {
    const { directory, project, running } = await emptyProject();
    try {
        const group = running.page.locator(`.project-group[data-project-id="${project.id}"]`);
        const projectRow = group.locator('.project-select');
        const emptyRow = group.locator('.empty-project');

        await projectRow.focus();
        await running.page.keyboard.press('ArrowDown');
        await expect(emptyRow).toBeFocused();
        /**
         * The row has to be leavable the same way it was reached. Base UI opens a root menu on ArrowUp/ArrowDown and
         * stops the event at the trigger, so without the suppression in `create-session-menu.tsx` these two keys pop
         * the Terminal menu open and the row becomes a keyboard trap: the only way out is Escape or the pointer.
         */
        await running.page.keyboard.press('ArrowUp');
        await expect(
            running.page.getByRole('menu', { name: `New Session in ${project.displayTitle}` }),
        ).toHaveCount(0);
        await expect(projectRow).toBeFocused();
        // No children of its own: Left returns to the Project heading, Right does nothing.
        await running.page.keyboard.press('ArrowDown');
        await running.page.keyboard.press('ArrowLeft');
        await expect(projectRow).toBeFocused();
        await running.page.keyboard.press('ArrowDown');
        await running.page.keyboard.press('ArrowRight');
        await expect(emptyRow).toBeFocused();

        await running.page.keyboard.press('Enter');
        /**
         * Deliberately the Terminal-less choice: a Session created with a Terminal hands focus to that Terminal's
         * input, which would hide whether the sidebar released the row's focus safely or dropped it.
         */
        await chooseTerminalFromCreateMenu(running.page, 'Start without a Terminal');
        const sessionCard = group.locator('.session-card');
        await expect(sessionCard).toHaveCount(1);
        await expect(emptyRow).toHaveCount(0);
        /**
         * The created Session replaces the row that was holding the tree's roving Tab stop, so without a handoff focus
         * would fall to the document body and Tab would re-enter the sidebar from the top.
         */
        await expect(sessionCard).toBeFocused();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
