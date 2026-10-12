import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

async function expectSyntaxColors(editor: Locator): Promise<void> {
    await expect
        .poll(() =>
            editor
                .locator('.view-lines span')
                .evaluateAll(
                    (spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size,
                ),
        )
        .toBeGreaterThan(1);
}

test('workspace file and directory links open and save without replacing links', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-workspace-links-e2e-'));
    const root = join(testDirectory, 'project');
    const shared = join(testDirectory, 'shared');
    await Promise.all([mkdir(root), mkdir(shared)]);
    await writeFile(join(shared, 'config.txt'), 'shared fixture\n');
    await Promise.all([
        symlink('../shared/config.txt', join(root, 'linked-config.txt')),
        symlink('../shared', join(root, 'linked-folder')),
    ]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        const tree = running.page.getByRole('tree', { name: 'Files' });
        await tree.getByRole('treeitem', { name: /^linked-config\.txt/ }).dblclick();
        const tab = running.page.locator('.work-tab', { hasText: 'linked-config.txt' });
        await expect(tab).toBeVisible();
        const editor = running.page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('shared fixture');
        await editor.click();
        await running.page.keyboard.press('Meta+End');
        await running.page.keyboard.type('saved through link');
        await running.page.keyboard.press('Meta+S');
        await expect
            .poll(() => readFile(join(shared, 'config.txt'), 'utf8'))
            .toContain('saved through link');
        expect((await lstat(join(root, 'linked-config.txt'))).isSymbolicLink()).toBe(true);
        const folder = tree.getByRole('treeitem', { name: /^linked-folder/ });
        await folder.focus();
        await folder.press('ArrowRight');
        await expect(folder).toHaveAttribute('aria-expanded', 'true');
        await tree.getByRole('treeitem', { name: 'config.txt', exact: true }).click();
        await expect(editor.locator('.view-lines')).toContainText('saved through link');
        await expect(tab).toBeVisible();
        await running.page.keyboard.press('Meta+P');
        const dialog = running.page.getByRole('dialog');
        const pathInput = dialog.getByRole('combobox', { name: 'File path' });
        await pathInput.fill('linked-folder/config');
        await expect(dialog.getByRole('option', { name: /^config\.txt/ })).toBeVisible();
        await pathInput.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(editor.locator('.view-lines')).toContainText('saved through link');
        await expect(running.page.locator('.toast')).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('custom dotfile languages support syntax highlighting and line comments', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-dotfile-syntax-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    await Promise.all([
        writeFile(join(root, '.env'), 'CAXRI_READY=true\n', 'utf8'),
        writeFile(
            join(root, '.gitignore'),
            '# Generated files\nnode_modules/\n!important.generated\nsrc/**/cache?.json\n',
            'utf8',
        ),
        writeFile(
            join(root, '.npmrc'),
            '# Package registry\nregistry=https://registry.npmjs.org\nstrict-ssl=true\nfetch-retries=3\n',
            'utf8',
        ),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: '.gitignore', exact: true }).click();
        const editor = running.page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('important.generated');
        await expectSyntaxColors(editor);
        await editor.locator('.view-line').nth(1).click();
        await running.page.keyboard.press('Meta+/');
        await expect(editor.locator('.view-line').nth(1)).toContainText('# node_modules/');

        await running.page.getByRole('treeitem', { name: '.npmrc', exact: true }).click();
        await expect(editor.locator('.view-lines')).toContainText('strict-ssl=true');
        await expectSyntaxColors(editor);
        await editor.locator('.view-line').nth(1).click();
        await running.page.keyboard.press('Meta+/');
        await expect(editor.locator('.view-line').nth(1)).toContainText(
            '# registry=https://registry.npmjs.org',
        );

        await running.page.getByRole('treeitem', { name: '.env', exact: true }).click();
        await expect(editor.locator('.view-lines')).toContainText('CAXRI_READY=true');
        await editor.locator('.view-line').first().click();
        await running.page.keyboard.press('Meta+/');
        await expect(editor.locator('.view-line').first()).toContainText('# CAXRI_READY=true');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('external link target changes refresh the editor and expanded directory', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-external-links-sync-e2e-'));
    const root = join(testDirectory, 'project');
    const shared = join(testDirectory, 'shared');
    await Promise.all([mkdir(root), mkdir(shared)]);
    const target = join(shared, 'note.txt');
    await writeFile(target, 'initial external fixture\n');
    await Promise.all([
        symlink('../shared/note.txt', join(root, 'linked-note.txt')),
        symlink('../shared', join(root, 'linked-folder')),
    ]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        const tree = running.page.getByRole('tree', { name: 'Files' });
        await tree.getByRole('treeitem', { name: /^linked-note\.txt/ }).dblclick();
        const editor = running.page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('initial external fixture');
        await writeFile(target, 'clean external replacement\n');
        await expect(editor.locator('.view-lines')).toContainText('clean external replacement');
        const notice = running.page.getByText(/were replaced by changes on disk/);
        await expect(notice).not.toBeVisible();
        await editor.click();
        await running.page.keyboard.press('Meta+End');
        await running.page.keyboard.type('unsaved local fixture');
        await expect(editor.locator('.view-lines')).toContainText('unsaved local fixture');
        await writeFile(target, 'external change takes precedence\n');
        await expect(editor.locator('.view-lines')).toContainText(
            'external change takes precedence',
        );
        await expect(notice).toBeVisible();
        const folder = tree.getByRole('treeitem', { name: /^linked-folder/ });
        await folder.focus();
        await folder.press('ArrowRight');
        await expect(folder).toHaveAttribute('aria-expanded', 'true');
        await writeFile(join(shared, 'created-outside.txt'), 'new fixture');
        const added = tree.getByRole('treeitem', { name: 'created-outside.txt', exact: true });
        await expect(added).toBeVisible();
        await running.page.screenshot({
            path: test.info().outputPath('external-link-updates.png'),
        });
        await unlink(join(shared, 'created-outside.txt'));
        await expect(added).not.toBeVisible();
        expect((await lstat(join(root, 'linked-note.txt'))).isSymbolicLink()).toBe(true);
        await running.page.screenshot({
            path: test.info().outputPath('external-link-deletion.png'),
        });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
