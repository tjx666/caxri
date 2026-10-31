import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { openSettingsPage, openSettingsSection } from './support/settings.ts';

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
        // Not `openSettingsPage`: that helper's own visibility wait would resolve trivially (the
        // outer `data-settings-page` wrapper mounts synchronously; only the data inside it awaits
        // the gate below) but adds a retrying assertion between the press and the gate wait this
        // test deliberately keeps tight.
        const settingsTab = running.page.locator('[data-settings-page]');
        const theme = settingsTab
            .getByRole('navigation', { name: 'Settings categories' })
            .getByRole('button', { name: 'Theme', exact: true });
        await theme.click();
        await expect(theme).toHaveAttribute('aria-current', 'page');
        await running.page.evaluate(() => {
            (
                globalThis as typeof globalThis & {
                    caxriE2E: { releaseSettingsLoadGate(): void };
                }
            ).caxriE2E.releaseSettingsLoadGate();
        });
        await expect(settingsTab.getByRole('button', { name: 'Import Theme' })).toBeVisible();
        await expect(theme).toHaveAttribute('aria-current', 'page');
        // Escape closes the window-level Settings page (issue caxri#2369). The page stays mounted
        // while hidden, so the untargeted reopen below must move it back to the Settings list.
        await running.page.keyboard.press('Escape');
        await expect(settingsTab).toBeHidden();
        await running.page.keyboard.press('Meta+,');
        await expect(settingsTab.getByLabel('Search settings')).toBeVisible();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('Settings opens over a focused Terminal and Escape hands focus back to it', async () => {
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

        const settingsPage = await openSettingsPage(running.page);
        // The search field takes focus on open: a first Escape clears a query, and only an empty field closes the page.
        const search = settingsPage.getByLabel('Search settings');
        await expect(search).toBeFocused();
        await search.pressSequentially('font');
        await running.page.keyboard.press('Escape');
        await expect(search).toHaveValue('');
        await expect(settingsPage).toBeVisible();
        await running.page.keyboard.press('Escape');
        await expect(settingsPage).toBeHidden();
        await expect(terminalInput).toBeFocused();

        // Settings is a window-level page, never a pane tab (issue caxri#2369).
        const bootstrap = await pageRequest<{ sessionStates: Array<{ paneLayout?: unknown }> }>(
            running.page,
            'app.bootstrap',
        );
        expect(JSON.stringify(bootstrap.sessionStates)).not.toContain('caxri-settings://');
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
        const settingsTab = await openSettingsPage(running.page);
        await openSettingsSection(settingsTab, 'Keybindings');

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
        // the capture-phase dispatcher consumes the command behind the Settings page.
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

        // `Cmd+W` closes the Settings page (issue caxri#2369), so the rest of this check exercises
        // the custom binding against the plain Workbench.
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
        const welcome = running.page.locator('[data-workbench-welcome]');
        await expect(welcome).toBeVisible();
        await running.page.keyboard.press('Meta+,');
        const settingsPage = running.page.locator('[data-settings-page]');
        await expect(settingsPage).toBeVisible();
        await expect(welcome).toBeHidden();
        await settingsPage.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(settingsPage).toBeHidden();
        await expect(welcome).toBeVisible();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
