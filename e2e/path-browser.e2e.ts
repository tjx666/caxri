import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { createShellSession, launchCaxri } from './helpers.ts';

test('Cmd+P lazily browses Project paths from Terminal, Editor, and Files focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-path-browser-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await Promise.all([
        writeFile(join(root, 'README.md'), '# Project\n', 'utf8'),
        writeFile(
            join(root, 'src', 'nested', 'target.ts'),
            'export const target = true;\n',
            'utf8',
        ),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);

        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await terminalInput.press('Meta+P');
        let dialog = running.page.getByRole('dialog');
        let input = dialog.getByRole('combobox', { name: 'File path' });
        await expect(input).toBeFocused();
        const rootListbox = dialog.getByRole('listbox', { name: 'Files in current directory' });
        const rootDirectoryOption = dialog.getByRole('option', { name: 'src' });
        await expect(rootDirectoryOption).toBeVisible();
        const rootListboxId = await rootListbox.getAttribute('id');
        const rootOptionId = await rootDirectoryOption.getAttribute('id');
        expect(rootListboxId).not.toBeNull();
        expect(rootOptionId).not.toBeNull();
        await expect(input).toHaveAttribute('aria-controls', rootListboxId!);
        await expect(input).toHaveAttribute('aria-activedescendant', rootOptionId!);
        await input.dispatchEvent('keydown', {
            bubbles: true,
            code: 'Enter',
            isComposing: true,
            key: 'Enter',
        });
        await expect(dialog.getByRole('button', { name: 'Parent directory' })).toBeDisabled();
        const firstActiveOption = await input.getAttribute('aria-activedescendant');
        await input.press('ArrowDown');
        await expect
            .poll(() => input.getAttribute('aria-activedescendant'))
            .not.toBe(firstActiveOption);
        await expect(dialog.getByText('target.ts')).toHaveCount(0);
        await input.fill('read');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Tab');
        await expect(input).toHaveValue('README.md');
        await input.press('Enter');
        await expect(dialog).toHaveCount(0);
        const readmeTab = running.page.locator('.work-tab', { hasText: 'README.md' });
        await expect(readmeTab).toBeVisible();

        const editor = running.page.locator('.monaco-editor');
        await editor.click({ position: { x: 120, y: 24 } });
        await expect
            .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);
        await running.page.keyboard.press('Meta+P');
        dialog = running.page.getByRole('dialog');
        input = dialog.getByRole('combobox', { name: 'File path' });
        await input.fill('src');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('ArrowRight');
        await expect(dialog).toContainText('src/');
        await input.fill('nested');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await expect(dialog).toContainText('src/nested/');
        await input.fill('tar');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Tab');
        await expect(input).toHaveValue('target.ts');
        await input.press('Enter');
        await expect(running.page.locator('.work-tab', { hasText: 'target.ts' })).toBeVisible();

        const readmeFileRow = running.page
            .locator('.file-list')
            .getByRole('button', { name: 'README.md', exact: true });
        await readmeFileRow.focus();
        await running.page.keyboard.press('Meta+P');
        dialog = running.page.getByRole('dialog');
        input = dialog.getByRole('combobox', { name: 'File path' });
        await input.fill('src');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await expect(dialog).toContainText('src/');
        await input.press('ArrowLeft');
        await expect(dialog.getByRole('option', { name: 'src' })).toBeVisible();
        await input.fill('src');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await input.fill('../');
        await expect(dialog.getByRole('option', { name: 'README.md' })).toBeVisible();
        await input.press('Escape');
        await expect(dialog).toHaveCount(0);

        await running.page.keyboard.press('Meta+Shift+P');
        await expect(running.page.getByRole('dialog')).toContainText('Commands');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
