import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    unlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

test('a missing file save shows a safe reason and retries after the file is restored', async () => {
    allowE2EErrors([
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-save-toast-recovery-'));
    const root = join(testDirectory, 'project');
    const path = join(root, 'note.txt');
    await mkdir(root);
    await writeFile(path, 'original\n');
    /**
     * Rewriting a restored file gives it a new mtime, which Caxri treats as an external change that replaces even a
     * dirty buffer; whether that reload beat the Retry click used to decide this test. A whole-second mtime can be
     * restored exactly, so the restored file is the same disk state the buffer was read from.
     */
    const mtimeSeconds = 1_700_000_000;
    await utimes(path, mtimeSeconds, mtimeSeconds);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });

    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'note.txt', exact: true }).dblclick();
        const editor = running.page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('original');
        await editor.click();
        await running.page.keyboard.press('Meta+End');
        await running.page.keyboard.type('updated');
        await unlink(path);
        await running.page.keyboard.press('Meta+S');

        const failure = running.page.locator('.toast', { hasText: 'Save failed.' });
        await expect(failure).toContainText('Requested path no longer exists.');
        await expect(failure).not.toContainText('ENOENT');
        await expect(failure).not.toContainText(root);
        const retry = failure.getByRole('button', { name: 'Retry Save failed' });
        await expect(retry).toBeVisible();
        await failure.screenshot({ path: test.info().outputPath('save-enoent-toast.png') });

        const restored = join(testDirectory, 'note-restored.txt');
        await writeFile(restored, 'original\n');
        await utimes(restored, mtimeSeconds, mtimeSeconds);
        await rename(restored, path);
        await retry.click();
        await expect.poll(() => readFile(path, 'utf8')).toContain('updated');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('a failed save retries at the renamed editor path', async () => {
    allowE2EErrors([
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
        { source: 'desktop', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-save-renamed-recovery-'));
    const root = join(testDirectory, 'project');
    const path = join(root, 'note.txt');
    const renamedPath = join(root, 'renamed.txt');
    await mkdir(root);
    await writeFile(path, 'original\n');
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });

    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'note.txt', exact: true }).dblclick();
        const editor = running.page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('original');
        await editor.click();
        await running.page.keyboard.press('Meta+End');
        await running.page.keyboard.type('updated');
        await chmod(root, 0o500);
        await running.page.keyboard.press('Meta+S');

        const failure = running.page.locator('.toast', { hasText: 'Save failed.' });
        await expect(failure).toBeVisible();
        const retry = failure.getByRole('button', { name: 'Retry Save failed' });
        await expect(retry).toBeVisible();
        await failure.hover();

        await chmod(root, 0o700);
        const row = running.page.getByRole('treeitem', { name: 'note.txt', exact: true });
        await expect(row).toBeVisible();
        await row.focus();
        await running.page.keyboard.press('Enter');
        const rename = running.page.getByRole('textbox', { name: 'Rename note.txt' });
        await rename.fill('renamed.txt');
        await rename.press('Enter');
        await expect(running.page.locator('.work-tab', { hasText: 'renamed.txt' })).toBeVisible();

        await retry.click();
        await expect.poll(() => readFile(renamedPath, 'utf8')).toContain('updated');
    } finally {
        await chmod(root, 0o700);
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('a failed Terminal launch can retry after its folder becomes available', async () => {
    allowE2EErrors([
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
        { source: 'desktop', event: 'ipc.request_failed', code: 'IO', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'IO', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-toast-recovery-'));
    const root = join(testDirectory, 'project');
    const folder = join(root, 'volatile');
    await mkdir(folder, { recursive: true });
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });

    try {
        await createProjectSession(running.page);
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
        /**
         * The folder is made inaccessible before its menu is opened, never while it is open. A mode change is a watched
         * filesystem event, so the Files tree refreshes on it; doing that behind an open context menu means the menu's
         * own row can be re-rendered out from under it, which is how `Open in Terminal` went missing for the full click
         * timeout in CI. The row itself stays listed either way: reading the parent directory is what enumerates it,
         * and that is still permitted.
         */
        await chmod(folder, 0o000);
        const volatileRow = running.page.getByRole('treeitem', { name: 'volatile', exact: true });
        await expect(volatileRow).toBeVisible();
        await volatileRow.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Open in Terminal');

        const failure = running.page.locator('.toast', { hasText: 'Terminal creation failed.' });
        await expect(failure).toBeVisible();
        await expect(failure).not.toContainText(folder);
        const retry = failure.getByRole('button', { name: 'Retry Terminal creation failed' });
        await expect(retry).toBeVisible();
        const [toastBounds, retryBounds] = await Promise.all([
            failure.boundingBox(),
            retry.boundingBox(),
        ]);
        if (!toastBounds || !retryBounds) throw new Error('Terminal failure action has no bounds');
        expect(retryBounds.x + retryBounds.width).toBeLessThanOrEqual(
            toastBounds.x + toastBounds.width,
        );
        await failure.screenshot({
            path: test.info().outputPath('terminal-launch-failure-toast.png'),
        });

        await chmod(folder, 0o700);
        await retry.click();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
    } finally {
        await chmod(folder, 0o700);
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
