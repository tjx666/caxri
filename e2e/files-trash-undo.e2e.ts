import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

async function isPresent(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

test('Move to Trash raises no notice, and Cmd+Z restores the file without overwriting a new one', async () => {
    /**
     * The refused Undo is the product's deliberate answer to a name collision, shown as one error notification.
     */
    allowE2EErrors([{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-trash-undo-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    await Promise.all([
        writeFile(join(root, 'keep.txt'), 'keep me\n', 'utf8'),
        writeFile(join(root, 'taken.txt'), 'original\n', 'utf8'),
    ]);

    const running = await launchCaxri({
        env: { CAXRI_E2E_TRASH_DIR: join(testDirectory, 'fixture-trash') },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await createProjectSession(running.page);
        const tree = running.page.locator('.file-list').first();
        const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });

        await row('keep.txt').click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Move to Trash');
        await expect(row('keep.txt')).toHaveCount(0);
        // The row leaving the tree is the feedback; Cmd+Z takes it back, so nothing announces it.
        await expect(running.page.locator('[data-sonner-toast]')).toHaveCount(0);

        await row('taken.txt').focus();
        await running.page.keyboard.press('Meta+z');
        await expect(row('keep.txt')).toBeVisible();
        await expect(readFile(join(root, 'keep.txt'), 'utf8')).resolves.toBe('keep me\n');
        await expect(running.page.locator('[data-sonner-toast]')).toHaveCount(0);

        await row('taken.txt').focus();
        await running.page.keyboard.press('Meta+Backspace');
        await expect(row('taken.txt')).toHaveCount(0);
        await writeFile(join(root, 'taken.txt'), 'newer file\n', 'utf8');

        await running.page.keyboard.press('Meta+z');
        await expect(
            running.page.getByText("Couldn't restore 'taken.txt'", { exact: false }),
        ).toBeVisible();
        await expect(readFile(join(root, 'taken.txt'), 'utf8')).resolves.toBe('newer file\n');
        await expect(isPresent(join(testDirectory, 'fixture-trash'))).resolves.toBe(true);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Cmd+Z in the Files tree restores the latest Trash and goes stale after a rename', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-trash-undo-key-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    await Promise.all([
        writeFile(join(root, 'old.txt'), 'old\n', 'utf8'),
        writeFile(join(root, 'recent.txt'), 'recent\n', 'utf8'),
        writeFile(join(root, 'rename-me.txt'), 'rename\n', 'utf8'),
    ]);

    const running = await launchCaxri({
        env: { CAXRI_E2E_TRASH_DIR: join(testDirectory, 'fixture-trash') },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await createProjectSession(running.page);
        const tree = running.page.locator('.file-list').first();
        const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });

        await row('old.txt').click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Move to Trash');
        await expect(row('old.txt')).toHaveCount(0);

        // A rename after the Trash makes it stale: Cmd+Z must not bring the older deletion back.
        await row('rename-me.txt').focus();
        await running.page.keyboard.press('Enter');
        const renameInput = running.page.getByRole('textbox', { name: 'Rename rename-me.txt' });
        await renameInput.fill('renamed.txt');
        await renameInput.press('Enter');
        await expect(row('renamed.txt')).toBeVisible();
        await row('renamed.txt').focus();
        await running.page.keyboard.press('Meta+z');
        await expect(row('old.txt')).toHaveCount(0);
        await expect(isPresent(join(root, 'old.txt'))).resolves.toBe(false);

        // The shortcut deletes too, and keeps focus in the tree so Cmd+Z reaches it without another click.
        await row('recent.txt').focus();
        await running.page.keyboard.press('Meta+Backspace');
        await expect(row('recent.txt')).toHaveCount(0);
        await expect(row('renamed.txt')).toBeFocused();

        await running.page.keyboard.press('Meta+z');
        await expect(row('recent.txt')).toBeVisible();
        await expect(readFile(join(root, 'recent.txt'), 'utf8')).resolves.toBe('recent\n');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
