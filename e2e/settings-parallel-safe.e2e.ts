import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './fixtures.ts';

import { createShellSession, launchCaxri, pageRequest } from './helpers.ts';

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
        await running.app.close().catch(() => undefined);
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
        await search.fill('toggle inspector');
        // Filtered on the command id, not the title: a conflict is now reported on both colliding
        // rows, so each row's text contains the *other* command's title and a title filter would
        // match two rows once the conflict below exists. The id appears only on its own row.
        const inspectorRow = dialog.getByRole('listitem').filter({ hasText: 'inspector.toggle' });
        const inspectorEdit = inspectorRow.getByRole('button', {
            name: 'Edit shortcut for Toggle Inspector',
        });
        await expect(inspectorRow).toContainText('inspector.toggle');
        await expect(inspectorRow.locator('[data-shortcut="cmd+]"] kbd')).toHaveCount(2);

        await inspectorEdit.click();
        await inspectorEdit.press('Meta+Alt+O');
        await expect(inspectorEdit).toContainText('⌥⌘O');
        await inspectorEdit.press('Escape');
        await expect(inspectorEdit).toBeFocused();
        await expect(inspectorRow.locator('[data-shortcut="cmd+]"]')).toBeVisible();

        await inspectorEdit.click();
        await inspectorEdit.press('Meta+Alt+I');
        await inspectorEdit.press('Enter');
        await expect(inspectorRow.locator('[data-shortcut="cmd+alt+i"]')).toBeVisible();
        // Structured edits write immediately (debounced); wait for this one to land before layering
        // a conflicting edit on top of it.
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find((binding) => binding.command === 'inspector.toggle')?.key;
            })
            .toBe('cmd+alt+i');

        // Keep both rows visible (a narrower "toggle primary sidebar" search would hide Toggle
        // Inspector) so the conflict this creates can be checked on both colliding rows.
        await search.fill('toggle');
        const sidebarRow = dialog.getByRole('listitem').filter({ hasText: 'sidebar.toggle' });
        const sidebarEdit = sidebarRow.getByRole('button', {
            name: 'Edit shortcut for Toggle Primary Sidebar',
        });
        await sidebarEdit.click();
        await sidebarEdit.press('Meta+Alt+I');
        await sidebarEdit.press('Enter');
        // A conflict is reported inline on both rows and never blocks the write (there is no
        // `applyDisabled` gate anymore): both rows keep the colliding chord and it still persists.
        await expect(sidebarRow.locator('[data-shortcut="cmd+alt+i"]')).toBeVisible();
        await expect(sidebarRow).toContainText('Conflicts with Toggle Inspector');
        await expect(inspectorRow).toContainText('Conflicts with Toggle Primary Sidebar');
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find((binding) => binding.command === 'sidebar.toggle')?.key;
            })
            .toBe('cmd+alt+i');

        await sidebarRow
            .getByRole('button', { name: 'Reset shortcut for Toggle Primary Sidebar' })
            .click();
        await expect(sidebarRow.locator('[data-shortcut="cmd+["]')).toBeVisible();
        await expect(sidebarRow).not.toContainText('Conflicts with');
        await expect(inspectorRow).not.toContainText('Conflicts with');
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find((binding) => binding.command === 'sidebar.toggle')?.key;
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
                return result.value.find((binding) => binding.command === 'inspector.searchFiles')
                    ?.key;
            })
            .toBe('cmd+shift+f');

        await running.page.keyboard.press('Escape');
        await expect(running.page.locator('.inspector')).toBeVisible();
        await running.page.keyboard.press('Meta+Alt+I');
        await expect(running.page.locator('.inspector')).toHaveCount(0);
        await running.page.keyboard.press('Meta+Alt+I');
        await expect(running.page.locator('.inspector')).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
