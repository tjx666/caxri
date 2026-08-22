import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';

test('Settings shortcut opens while Terminal input has focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-shortcut-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();

        await running.page.keyboard.press('Meta+,');

        await expect(running.page.getByRole('dialog')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Keyboard Shortcuts records, validates, resets, and dispatches a custom binding', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-keybindings-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        await dialog.getByRole('tab', { name: 'Keybindings', exact: true }).click();

        const search = dialog.getByLabel('Search keyboard shortcuts');
        await search.fill('toggle secondarySidebar');
        // Filtered on the command id, not the title: a conflict is now reported on both colliding
        // rows, so each row's text contains the *other* command's title and a title filter would
        // match two rows once the conflict below exists. The id appears only on its own row.
        const secondarySidebarRow = dialog
            .getByRole('listitem')
            .filter({ hasText: 'secondarySidebar.toggle' });
        const secondarySidebarEdit = secondarySidebarRow.getByRole('button', {
            name: 'Edit shortcut for Toggle Secondary Side Bar',
        });
        await expect(secondarySidebarRow).toContainText('secondarySidebar.toggle');
        await expect(secondarySidebarRow.locator('[data-shortcut="cmd+]"] kbd')).toHaveCount(2);

        // The chord already belongs to Session MRU globally. Recording must receive it before
        // the capture-phase dispatcher consumes the command behind the Settings modal.
        await secondarySidebarEdit.click();
        await secondarySidebarEdit.press('Control+Alt+Tab');
        await expect(secondarySidebarEdit).toContainText('⌃⌥⇥');
        await secondarySidebarEdit.press('Escape');
        await expect(secondarySidebarRow.locator('[data-shortcut="cmd+]"]')).toBeVisible();

        await secondarySidebarEdit.click();
        await secondarySidebarEdit.press('Meta+Alt+O');
        await expect(secondarySidebarEdit).toContainText('⌥⌘O');
        await secondarySidebarEdit.press('Escape');
        await expect(secondarySidebarEdit).toBeFocused();
        await expect(secondarySidebarRow.locator('[data-shortcut="cmd+]"]')).toBeVisible();

        await secondarySidebarEdit.click();
        await secondarySidebarEdit.press('Meta+Alt+I');
        await secondarySidebarEdit.press('Enter');
        await expect(secondarySidebarRow.locator('[data-shortcut="cmd+alt+i"]')).toBeVisible();
        // Structured edits write immediately (debounced); wait for this one to land before layering
        // a conflicting edit on top of it.
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find((binding) => binding.command === 'secondarySidebar.toggle')
                    ?.key;
            })
            .toBe('cmd+alt+i');

        // Keep both rows visible (a narrower "toggle primary primarySidebar" search would hide Toggle
        // SecondarySidebar) so the conflict this creates can be checked on both colliding rows.
        await search.fill('toggle');
        const primarySidebarRow = dialog
            .getByRole('listitem')
            .filter({ hasText: 'primarySidebar.toggle' });
        const primarySidebarEdit = primarySidebarRow.getByRole('button', {
            name: 'Edit shortcut for Toggle Primary Side Bar',
        });
        await primarySidebarEdit.click();
        await primarySidebarEdit.press('Meta+Alt+I');
        await primarySidebarEdit.press('Enter');
        // A conflict is reported inline on both rows and never blocks the write (there is no
        // `applyDisabled` gate anymore): both rows keep the colliding chord and it still persists.
        await expect(primarySidebarRow.locator('[data-shortcut="cmd+alt+i"]')).toBeVisible();
        await expect(primarySidebarRow).toContainText('Conflicts with Toggle Secondary Side Bar');
        await expect(secondarySidebarRow).toContainText('Conflicts with Toggle Primary Side Bar');
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find((binding) => binding.command === 'primarySidebar.toggle')
                    ?.key;
            })
            .toBe('cmd+alt+i');

        await primarySidebarRow
            .getByRole('button', { name: 'Reset shortcut for Toggle Primary Side Bar' })
            .click();
        await expect(primarySidebarRow.locator('[data-shortcut="cmd+["]')).toBeVisible();
        await expect(primarySidebarRow).not.toContainText('Conflicts with');
        await expect(secondarySidebarRow).not.toContainText('Conflicts with');
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find((binding) => binding.command === 'primarySidebar.toggle')
                    ?.key;
            })
            .toBe('cmd+[');

        await search.fill('search files');
        const searchFilesRow = dialog.getByRole('listitem').filter({ hasText: 'Search Files' });
        await searchFilesRow
            .getByRole('button', { name: 'Remove shortcut for Search Files' })
            .click();
        await expect(
            searchFilesRow.getByRole('button', { name: 'Add shortcut for Search Files' }),
        ).toBeFocused();
        await searchFilesRow
            .getByRole('button', { name: 'Reset shortcut for Search Files' })
            .click();
        await expect(searchFilesRow.locator('[data-shortcut="cmd+shift+f"]')).toBeVisible();
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find(
                    (binding) => binding.command === 'secondarySidebar.searchFiles',
                )?.key;
            })
            .toBe('cmd+shift+f');

        await running.page.keyboard.press('Escape');
        await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
        await running.page.keyboard.press('Meta+Alt+I');
        await expect(running.page.locator('.secondary-sidebar')).toHaveCount(0);
        await running.page.keyboard.press('Meta+Alt+I');
        await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
