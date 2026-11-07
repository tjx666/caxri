import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
} from './support/helpers.ts';
import { contextMenuLabels, dismissContextMenu } from './support/native-context-menu.ts';
import { openSettingsPage, revealSettingsSection } from './support/settings.ts';

async function rowIndex(editor: Locator, name: string): Promise<number> {
    const names = await editor
        .getByRole('listitem')
        .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
    return names.indexOf(name);
}

test('the Session menu follows the order and visibility chosen in Settings', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-menu-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const { app, page } = running;
        const sessionId = await createProjectSession(page, 'shell');
        const row = page.locator(`.project-group [data-session-id="${sessionId}"]`);

        await row.click({ button: 'right' });
        const builtIn = await contextMenuLabels(app);
        expect(builtIn[0]).toBe('Archive');
        expect(builtIn.at(-1)).toBe('Delete Session…');
        expect(builtIn.indexOf('Rename')).toBeLessThan(builtIn.indexOf('Delete Session…'));
        await dismissContextMenu(app);

        const settings = await openSettingsPage(page, { advanced: false });
        await revealSettingsSection(settings, 'General');
        const editor = settings.getByRole('region', { name: 'Session menu editor' });
        await editor.scrollIntoViewIfNeeded();
        await editor.getByRole('switch', { name: 'Show Archive' }).click();
        await expect(editor.getByRole('switch', { name: 'Show Archive' })).toHaveAttribute(
            'aria-checked',
            'false',
        );

        // Option+Up moves the focused row one place at a time: past the separator (which then trails and drops), then
        // past Rename with AI and Rename.
        const deleteRow = editor.getByRole('listitem', { name: 'Delete Session…', exact: true });
        const renameIndex = await rowIndex(editor, 'Rename');
        const moveUp = async (expected: number): Promise<void> => {
            await deleteRow.press('Alt+ArrowUp');
            await expect.poll(() => rowIndex(editor, 'Delete Session…')).toBe(expected);
        };
        await deleteRow.focus();
        await moveUp(renameIndex + 2);
        await moveUp(renameIndex + 1);
        await moveUp(renameIndex);
        await expect(deleteRow).toBeFocused();
        await page.screenshot({ path: test.info().outputPath('session-menu-settings.png') });
        await settings.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(settings).toBeHidden();
        // Settings debounces its writes, so wait for the Server to hold the edited layout before reading the menu.
        await expect
            .poll(async () => {
                const { value } = await pageRequest<{ value: Record<string, unknown> }>(
                    page,
                    'settings.get',
                );
                return value['primarySidebar.sessionMenu'];
            })
            .toMatchObject({ hidden: ['archive'] });

        await row.click({ button: 'right' });
        const customized = await contextMenuLabels(app);
        expect(customized).not.toContain('Archive');
        expect(customized.indexOf('Delete Session…')).toBeLessThan(customized.indexOf('Rename'));
        await dismissContextMenu(app);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
