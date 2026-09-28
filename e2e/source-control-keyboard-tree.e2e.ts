import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';
import {
    chooseContextMenuItem,
    dismissContextMenu,
    expectNoContextMenu,
} from './support/native-context-menu.ts';

test('Source Control navigates changed files with one tree Tab stop', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-source-control-tree-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(join(root, 'nested'), { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'before\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'after\n');
    await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
            writeFile(join(root, 'nested', `file-${String(index).padStart(2, '0')}.txt`), 'new\n'),
        ),
    );

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const tree = running.page.locator('.git-repositories[role="tree"]');
        const rows = tree.getByRole('treeitem');
        const provider = tree.locator('[data-row-id^="provider:"]');
        const group = tree.locator('[data-row-id^="group:"]').first();
        const branch = tree.locator('[data-row-id^="provider-branch:"]');
        const directory = tree.locator('[data-row-id^="directory:"]');
        await expect(directory).toBeVisible();
        // Provider, its branch row, the Changes caption, README.md, the directory with 20 files, and the Commits header.
        await expect(rows).toHaveCount(26);
        await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

        await provider.focus();
        await tree.screenshot({ path: test.info().outputPath('tree-focus-1-provider.png') });
        await running.page.keyboard.press('ArrowDown');
        await expect(branch).toBeFocused();
        await running.page.keyboard.press('ArrowDown');
        await expect(group).toBeFocused();
        await tree.screenshot({ path: test.info().outputPath('tree-focus-2-group.png') });
        /**
         * Group actions share the row menu, so keyboard access does not add another Tab stop to the tree.
         */
        await running.app.evaluate(({ dialog }) => {
            const scope = globalThis as Record<string, unknown>;
            scope.__caxriScmDiscardConfirmations = 0;
            dialog.showMessageBox = () => {
                scope.__caxriScmDiscardConfirmations =
                    Number(scope.__caxriScmDiscardConfirmations) + 1;
                return Promise.resolve({ response: 1, checkboxChecked: false });
            };
        });
        await running.page.keyboard.press('Shift+F10');
        await chooseContextMenuItem(running.app, 'Discard All Changes');
        await expect
            .poll(() =>
                running.app.evaluate(
                    () => (globalThis as Record<string, unknown>).__caxriScmDiscardConfirmations,
                ),
            )
            .toBe(1);
        await expectNoContextMenu(running.app);
        await expect(group).toBeFocused();
        await expect(rows).toHaveCount(26);
        await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

        await running.page.keyboard.press('ArrowDown');
        await expect(rows.nth(3)).toBeFocused();

        await directory.focus();
        await running.page.keyboard.press('Alt+Enter');
        await expect(directory).toHaveAttribute('aria-expanded', 'false');
        await expect(rows).toHaveCount(6);
        await running.page.keyboard.press('Alt+Enter');
        await expect(directory).toHaveAttribute('aria-expanded', 'true');
        await expect(rows).toHaveCount(26);
        await running.page.keyboard.press('ArrowRight');
        await expect(tree.locator('[data-row-id$="nested/file-00.txt"]')).toBeFocused();
        await tree.screenshot({ path: test.info().outputPath('tree-focus-3-file.png') });
        await running.page.keyboard.press('ArrowLeft');
        await expect(directory).toBeFocused();

        await running.page.keyboard.press('End');
        // End reaches the repository's collapsed `Commits` header, the last row of the tree.
        await expect(rows.last()).toBeFocused();
        await expect(rows.last()).toHaveAttribute('aria-expanded', 'false');

        // The row menu belongs to rows that carry actions; a section header has none.
        const readme = tree.locator('[data-row-id$="README.md"]');
        await readme.focus();
        await running.page.keyboard.press('Shift+F10');
        await dismissContextMenu(running.app);
        await expect(readme).toBeFocused();
        await running.page.keyboard.press('Tab');
        expect(
            await running.page.evaluate(
                () => document.activeElement?.getAttribute('role') === 'treeitem',
            ),
        ).toBe(false);
        await tree.screenshot({ path: test.info().outputPath('tree-focus-4-left.png') });

        await readme.focus();
        await running.page.keyboard.press('Enter');
        await expect(
            running.page.getByRole('tab', { name: 'README.md', exact: true }),
        ).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
