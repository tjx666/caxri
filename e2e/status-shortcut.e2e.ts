import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    VISIBLE_TERMINAL_INPUT,
} from './support/helpers.ts';

function sidebarTab(page: Page, name: string) {
    return page
        .getByRole('tablist', { name: 'Secondary Side Bar' })
        .getByRole('tab', { name, exact: true });
}

async function expectSelected(page: Page, name: string): Promise<void> {
    await expect(sidebarTab(page, name)).toHaveAttribute('aria-selected', 'true');
}

test('Project Status shortcut works from editable focus and keeps its live binding discoverable', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-status-shortcut-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), '# Status shortcut fixture\n', 'utf8');
    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });

    try {
        await createShellSession(running.page);
        const terminalInput = running.page.locator(VISIBLE_TERMINAL_INPUT).last();
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();

        await running.page.keyboard.press('Meta+]');
        await expect(running.page.getByRole('tablist', { name: 'Secondary Side Bar' })).toHaveCount(
            0,
        );
        await running.page.keyboard.press('Meta+Alt+3');
        await expectSelected(running.page, 'Status');
        await running.page.keyboard.press('Meta+Alt+3');
        await expectSelected(running.page, 'Status');

        await running.page.keyboard.press('Meta+Alt+1');
        await expectSelected(running.page, 'Files');
        await running.page.keyboard.press('Meta+Shift+F');
        // Content is the default mode, so the shortcut lands on the content input.
        const searchInput = running.page.getByRole('combobox', {
            name: 'Search Project contents',
        });
        await expect(searchInput).toBeFocused();
        const composingEventWasNotCanceled = await searchInput.evaluate((target) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    bubbles: true,
                    cancelable: true,
                    code: 'Digit3',
                    isComposing: true,
                    key: '3',
                    metaKey: true,
                }),
            ),
        );
        expect(composingEventWasNotCanceled).toBe(true);
        /**
         * Search Files is a modal overlay now, so it both holds the keyboard until it is dismissed and takes the rest
         * of the window out of the accessibility tree. The view container is still Files underneath, but that can only
         * be asserted after the overlay closes, because while it is open the sidebar tab is not reachable by role.
         */
        await running.page.keyboard.press('Escape');
        await expect(searchInput).toHaveCount(0);
        await expectSelected(running.page, 'Files');
        await running.page.keyboard.press('Meta+Alt+3');
        await expectSelected(running.page, 'Status');

        await running.page.keyboard.press('Meta+Alt+2');
        await expectSelected(running.page, 'Git');
        await sidebarTab(running.page, 'Git').focus();
        await running.page.keyboard.press('Meta+Alt+3');
        await expectSelected(running.page, 'Status');

        await running.page.keyboard.press('Meta+P');
        const pathDialog = running.page.getByRole('dialog');
        const pathInput = pathDialog.getByRole('combobox', { name: 'File path' });
        await pathInput.fill('readme');
        await expect(pathInput).toHaveAttribute('aria-busy', 'false');
        await pathInput.press('Enter');
        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 120, y: 24 } });
        await expect
            .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);
        await running.page.keyboard.press('Meta+Alt+2');
        await expectSelected(running.page, 'Git');
        await running.page.keyboard.press('Meta+Alt+3');
        await expectSelected(running.page, 'Status');

        const statusTab = sidebarTab(running.page, 'Status');
        /**
         * Selection precedes the view's asynchronous initialization. Its first badge/tree refresh can cancel a pending
         * hover tooltip, so wait for this fixture's settled empty state before starting the hover delay.
         */
        await expect(
            running.page.getByRole('tree', { name: 'Project Status' }).getByRole('treeitem', {
                name: /^No Git repository, Initialize a Git repository/,
            }),
        ).toBeVisible();
        await statusTab.hover();
        const statusTooltip = running.page
            .locator('.tooltip-popup:visible')
            .filter({ hasText: 'Status' });
        await expect(statusTooltip.locator('[data-shortcut="cmd+alt+3"]')).toBeVisible();
        await running.page.mouse.move(0, 0);

        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('secondarySidebar.showStatus');
        const showStatus = palette.getByRole('option', { name: /Show Status/ });
        await expect(showStatus).toBeVisible();
        await expect(showStatus.locator('[data-shortcut="cmd+alt+3"]')).toBeVisible();
        await running.page.keyboard.press('Escape');

        const keybindings = await pageRequest<{
            value: Array<{ command: string; key: string }>;
        }>(running.page, 'keybindings.get');
        expect(
            keybindings.value.filter(
                (binding) => binding.command === 'secondarySidebar.showStatus',
            ),
        ).toEqual([{ key: 'cmd+alt+3', command: 'secondarySidebar.showStatus' }]);
        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(
                keybindings.value.map((binding) =>
                    binding.command === 'secondarySidebar.showStatus'
                        ? { ...binding, key: 'cmd+alt+4' }
                        : binding,
                ),
                null,
                2,
            ),
        });

        await sidebarTab(running.page, 'Files').click();
        await running.page.keyboard.press('Meta+Alt+3');
        await expectSelected(running.page, 'Files');
        await running.page.keyboard.press('Meta+Alt+4');
        await expectSelected(running.page, 'Status');
        await running.page.mouse.move(0, 0);
        await statusTab.hover();
        await expect(statusTooltip.locator('[data-shortcut="cmd+alt+4"]')).toBeVisible();

        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await sidebarTab(running.page, 'Files').click();
        await running.page.keyboard.press('Meta+Alt+4');
        await expectSelected(running.page, 'Status');
        await sidebarTab(running.page, 'Status').hover();
        await expect(
            running.page
                .locator('.tooltip-popup:visible')
                .filter({ hasText: 'Status' })
                .locator('[data-shortcut="cmd+alt+4"]'),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
