import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    openSettingsTab,
    pageRequest,
} from './support/helpers.ts';

test('Settings preserves a tab selected while its initial configuration is loading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-settings-load-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
    });
    try {
        await running.page.evaluate(() => {
            (
                globalThis as typeof globalThis & {
                    caxriE2E: { armSettingsLoadGate(): void };
                }
            ).caxriE2E.armSettingsLoadGate();
        });
        await running.page.keyboard.press('Meta+,');
        await running.page.evaluate(() =>
            (
                globalThis as typeof globalThis & {
                    caxriE2E: { waitForSettingsLoadGate(): Promise<void> };
                }
            ).caxriE2E.waitForSettingsLoadGate(),
        );
        // Not `openSettingsTab`: that helper's own visibility wait would resolve trivially (the
        // outer `data-settings-page` wrapper mounts synchronously; only the data inside it awaits
        // the gate below) but adds a retrying assertion between the press and the gate wait this
        // test deliberately keeps tight.
        const settingsTab = running.page.locator('[data-settings-page]');
        const theme = settingsTab.getByRole('tab', { name: 'Theme', exact: true });
        await theme.click();
        await expect(theme).toHaveAttribute('aria-selected', 'true');
        await running.page.evaluate(() => {
            (
                globalThis as typeof globalThis & {
                    caxriE2E: { releaseSettingsLoadGate(): void };
                }
            ).caxriE2E.releaseSettingsLoadGate();
        });
        await expect(settingsTab.getByRole('button', { name: 'Import Theme' })).toBeVisible();
        await expect(theme).toHaveAttribute('aria-selected', 'true');
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes
        // the active tab the same way it would close any other document tab, which is the
        // tab-appropriate replacement for the old "Escape to dismiss the dialog" step this test
        // used to force a fresh mount before reopening.
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);
        await running.page.keyboard.press('Meta+,');
        await expect(
            settingsTab.getByRole('tab', { name: 'Settings', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

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

        await openSettingsTab(running.page);
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
        const settingsTab = await openSettingsTab(running.page);
        await settingsTab.getByRole('tab', { name: 'Keybindings', exact: true }).click();

        const search = settingsTab.getByLabel('Search keyboard shortcuts');
        await search.fill('secondarySidebar.toggle');
        // Filtered on the command id, not the title: a conflict is now reported on both colliding
        // rows, so each row's text contains the *other* command's title and a title filter would
        // match two rows once the conflict below exists. The id appears only on its own row.
        const secondarySidebarRow = settingsTab
            .getByRole('listitem')
            .filter({ hasText: 'secondarySidebar.toggle' });
        const secondarySidebarEdit = secondarySidebarRow.getByRole('button', {
            name: 'Edit shortcut for Toggle Secondary Side Bar',
        });
        await expect(secondarySidebarRow).toContainText('secondarySidebar.toggle');
        await expect(secondarySidebarRow.locator('[data-shortcut="cmd+]"] kbd')).toHaveCount(2);

        // The chord already belongs to Session MRU globally. Recording must receive it before
        // the capture-phase dispatcher consumes the command behind the Settings tab.
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
        /*
         * Located by its own Edit button rather than by the command id: `hasText` is a substring
         * match, and `primarySidebar.toggleActivity` contains `primarySidebar.toggle`, so the id
         * alone resolves to two rows and trips strict mode.
         */
        const primarySidebarEditName = 'Edit shortcut for Toggle Primary Side Bar';
        const primarySidebarRow = settingsTab.getByRole('listitem').filter({
            has: running.page.getByRole('button', { name: primarySidebarEditName }),
        });
        const primarySidebarEdit = primarySidebarRow.getByRole('button', {
            name: primarySidebarEditName,
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
        const searchFilesRow = settingsTab
            .getByRole('listitem')
            .filter({ hasText: 'Search Files' });
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

        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes it
        // outright, the tab-appropriate replacement for the old "Escape to dismiss the dialog" step,
        // needed so the rest of this check exercises the custom binding against the plain
        // Workbench, with no Settings surface still mounted alongside it.
        await running.page.keyboard.press('Meta+w');
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

test('Settings opens before the first Project exists and closes back to the Welcome view', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-settings-welcome-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
    });
    try {
        const welcome = running.page.getByRole('heading', { name: 'Project-first development.' });
        await expect(welcome).toBeVisible();
        await running.page.keyboard.press('Meta+,');
        const settingsPage = running.page.locator('[data-settings-page]');
        await expect(settingsPage).toBeVisible();
        await expect(welcome).toHaveCount(0);
        await running.page.getByRole('button', { name: 'Close Settings' }).click();
        await expect(settingsPage).toHaveCount(0);
        await expect(welcome).toBeVisible();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
