import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { createProjectSession, launchCaxri, pageRequest } from './helpers.ts';

test('Files supports safe create, clipboard, reveal, Terminal, move, and Trash workflows', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-operations-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    const destination = join(root, 'destination');
    const sourceFolder = join(root, 'source-folder');
    await Promise.all([
        mkdir(destination, { recursive: true }),
        mkdir(join(sourceFolder, 'nested'), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(join(root, 'cut.txt'), 'cut\n', 'utf8'),
        writeFile(join(root, 'draft.txt'), 'draft\n', 'utf8'),
        writeFile(join(destination, 'cut.txt'), 'existing\n', 'utf8'),
        writeFile(join(sourceFolder, 'nested', 'value.txt'), 'nested\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.app.evaluate(({ dialog, shell }) => {
            const { rename } = process.getBuiltinModule('node:fs').promises;
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
            shell.showItemInFolder = (path) => {
                Reflect.set(globalThis, '__caxriRevealedPath', path);
            };
            shell.trashItem = (path) => rename(path, `${path}.trashed`);
        });
        await createProjectSession(running.page);

        const caption = running.page.locator('.panel-caption');
        await caption.hover();
        await caption.getByRole('button', { name: 'New File' }).click();
        const newFileName = running.page.getByRole('textbox', { name: 'New file name' });
        await newFileName.fill('created.txt');
        await newFileName.press('Enter');
        await expect(running.page.locator('.work-tab', { hasText: 'created.txt' })).toBeVisible();
        await expect(
            running.page
                .locator('.file-list')
                .first()
                .getByRole('button', { name: 'created.txt', exact: true }),
        ).toBeFocused();
        await expect(readFile(join(root, 'created.txt'), 'utf8')).resolves.toBe('');

        const newFolderButton = caption.getByRole('button', { name: 'New Folder' });
        await newFolderButton.click();
        await running.page.getByRole('textbox', { name: 'New folder name' }).press('Escape');
        await expect(newFolderButton).toBeFocused();
        await newFolderButton.click();
        const newFolderName = running.page.getByRole('textbox', { name: 'New folder name' });
        await newFolderName.fill('created-folder');
        await newFolderName.press('Enter');
        await expect(
            running.page
                .locator('.file-list')
                .first()
                .getByRole('button', { name: 'created-folder', exact: true }),
        ).toBeFocused();
        await expect
            .poll(() =>
                access(join(root, 'created-folder'))
                    .then(() => true)
                    .catch(() => false),
            )
            .toBe(true);

        const fileList = running.page.locator('.file-list').first();
        const createdRow = fileList.getByRole('button', { name: 'created.txt', exact: true });
        await createdRow.focus();
        await running.page.keyboard.press('Enter');
        const conflictingName = running.page.getByRole('textbox', { name: 'Rename created.txt' });
        await conflictingName.fill('draft.txt');
        await conflictingName.press('Enter');
        await expect(fileList.getByRole('alert')).toContainText(
            'A file or folder with that name already exists',
        );
        await expect(conflictingName).toBeVisible();
        await conflictingName.press('Escape');
        await expect(createdRow).toBeFocused();

        const draftRow = fileList.getByRole('button', { name: 'draft.txt', exact: true });
        const destinationRow = fileList.getByRole('button', {
            name: 'destination',
            exact: true,
        });
        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe(join(root, 'draft.txt'));
        await draftRow.click({ button: 'right' });
        await running.page
            .getByRole('menuitem', { name: 'Copy Relative Path', exact: true })
            .click();
        await expect
            .poll(() => running.app.evaluate(({ clipboard }) => clipboard.readText()))
            .toBe('draft.txt');

        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Reveal in Finder' }).click();
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const value: unknown = Reflect.get(globalThis, '__caxriRevealedPath');
                    return typeof value === 'string' ? value : undefined;
                }),
            )
            .toBe(join(root, 'draft.txt'));

        const terminalCount = await pageRequest<{ terminals: unknown[] }>(
            running.page,
            'app.bootstrap',
        ).then((state) => state.terminals.length);
        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Open in Terminal' }).click();
        await expect
            .poll(async () => {
                const state = await pageRequest<{ terminals: Array<{ cwd: string }> }>(
                    running.page,
                    'app.bootstrap',
                );
                return {
                    count: state.terminals.length,
                    cwd: state.terminals.at(-1)?.cwd,
                };
            })
            .toEqual({ count: terminalCount + 1, cwd: root });
        await expect(running.page.locator('.xterm-helper-textarea').last()).toBeFocused();

        await draftRow.focus();
        await expect(draftRow).toBeFocused();
        await running.page.keyboard.press('Meta+C');
        await destinationRow.focus();
        await expect(destinationRow).toBeFocused();
        await running.page.keyboard.press('Meta+V');
        await expect
            .poll(() => readFile(join(destination, 'draft.txt'), 'utf8').catch(() => undefined))
            .toBe('draft\n');

        await draftRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Duplicate' }).click();
        await expect.poll(() => readFile(join(root, 'draft copy.txt'), 'utf8')).toBe('draft\n');

        const sourceFolderRow = fileList.getByRole('button', {
            name: 'source-folder',
            exact: true,
        });
        await sourceFolderRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
        await destinationRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
        await expect
            .poll(() =>
                readFile(join(destination, 'source-folder', 'nested', 'value.txt'), 'utf8').catch(
                    () => undefined,
                ),
            )
            .toBe('nested\n');

        const cutRow = fileList.getByRole('button', { name: 'cut.txt', exact: true });
        await cutRow.dblclick();
        await running.page.locator('.monaco-editor').click({ position: { x: 100, y: 24 } });
        await running.page.keyboard.press('End');
        await running.page.keyboard.type(' moved');
        const cutTab = running.page.locator('.work-tab', { hasText: 'cut.txt' });
        await expect(cutTab).toContainText('●');
        await cutRow.focus();
        await running.page.keyboard.press('Meta+X');
        await expect(cutRow).toHaveAttribute('data-cut', 'true');
        await destinationRow.focus();
        await running.page.keyboard.press('Meta+V');
        const cutMovedPath = join(destination, 'cut copy.txt');
        await expect
            .poll(() => readFile(cutMovedPath, 'utf8').catch(() => undefined))
            .toBe('cut\n');
        await expect(access(join(root, 'cut.txt'))).rejects.toThrow();
        const cutMovedTab = running.page.locator('.work-tab', { hasText: 'cut copy.txt' });
        await expect(cutMovedTab).toContainText('●');
        await cutMovedTab.click();
        await running.page.keyboard.press('Meta+S');
        await expect.poll(() => readFile(cutMovedPath, 'utf8')).toContain(' moved');

        await draftRow.dblclick();
        await running.page.locator('.monaco-editor').click({ position: { x: 100, y: 24 } });
        await running.page.keyboard.press('End');
        await running.page.keyboard.type(' dirty');
        const draftTab = running.page.locator('.work-tab', { hasText: 'draft.txt' });
        await expect(draftTab).toContainText('●');

        await draftRow.focus();
        await running.page.keyboard.press('Enter');
        const renameInput = running.page.getByRole('textbox', { name: 'Rename draft.txt' });
        await renameInput.fill('renamed.txt');
        await renameInput.press('Enter');
        const renamedTab = running.page.locator('.work-tab:not([inert])', {
            hasText: 'renamed.txt',
        });
        await expect(renamedTab).toContainText('●');
        await expect(access(join(root, 'draft.txt'))).rejects.toThrow();
        await expect(access(join(root, 'renamed.txt'))).resolves.toBeUndefined();

        const renamedRow = fileList.getByRole('button', { name: 'renamed.txt', exact: true });
        await expect(renamedRow).toBeFocused();
        await renamedRow.dragTo(destinationRow);
        const movedPath = join(destination, 'renamed.txt');
        await expect
            .poll(() =>
                access(movedPath)
                    .then(() => true)
                    .catch(() => false),
            )
            .toBe(true);
        await destinationRow.click();
        const movedRow = running.page
            .locator('.file-list')
            .getByRole('button', { name: 'renamed.txt', exact: true });
        await expect(movedRow).toBeVisible();

        await renamedTab.click();
        await running.page.keyboard.press('Meta+S');
        await expect.poll(() => readFile(movedPath, 'utf8').catch(() => '')).toContain(' dirty');

        await movedRow.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Move to Trash' }).click();
        await expect
            .poll(() =>
                access(`${movedPath}.trashed`)
                    .then(() => true)
                    .catch(() => false),
            )
            .toBe(true);
        await expect(access(movedPath)).rejects.toThrow();
        await expect(renamedTab).toHaveCount(0);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
