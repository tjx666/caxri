import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { createProjectSession, launchCaxri } from './helpers.ts';

test('Files supports create, Enter rename, drag move, and recoverable Trash', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-operations-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const destination = join(root, 'destination');
    await mkdir(destination, { recursive: true });
    await writeFile(join(root, 'draft.txt'), 'draft\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        await createProjectSession(running.page);

        const caption = running.page.locator('.panel-caption');
        await caption.hover();
        await caption.getByRole('button', { name: 'New File' }).click();
        const newFileName = running.page.getByRole('textbox', { name: 'New file name' });
        await newFileName.fill('created.txt');
        await newFileName.press('Enter');
        await expect(running.page.locator('.work-tab', { hasText: 'created.txt' })).toBeVisible();
        await expect(readFile(join(root, 'created.txt'), 'utf8')).resolves.toBe('');

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

        const draftRow = fileList.getByRole('button', { name: 'draft.txt', exact: true });
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
        const destinationRow = fileList.getByRole('button', {
            name: 'destination',
            exact: true,
        });
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
