import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

/**
 * Simulates the literal keystroke macOS delivers for Option+P: the OS composes Option+<letter>
 * into a symbol (`event.key === 'π'` for Option+P), not the plain letter. Playwright's synthetic
 * `press('Alt+P')` cannot reproduce this composition — its USKeyboardLayout table reports
 * `key: 'p'` for `KeyP` unconditionally, regardless of the Alt modifier, so it would pass equally
 * well against the pre-fix `event.key`-based chord matching and prove nothing about the regression
 * this shortcut migration fixed (see `keybindings.ts`'s `shortcutMainKey`). Dispatching the exact
 * composed event on the currently focused element instead exercises the real `event.code`-based
 * resolution end to end, the same way `keybindings.test.ts` already covers it at the unit level.
 */
async function pressOptionP(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', {
                altKey: true,
                bubbles: true,
                cancelable: true,
                code: 'KeyP',
                key: 'π',
            }),
        );
    });
}

test('Opt+P lazily browses Project paths from Terminal, Editor, and Files focus', async () => {
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
        await pressOptionP(running.page);
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
        await expect(input).toHaveAttribute('aria-busy', 'true');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Tab');
        await expect(input).toHaveValue('README.md');
        await input.press('Enter');
        await expect(dialog).toHaveCount(0);
        const readmeTab = running.page.locator('.work-tab', { hasText: 'README.md' });
        await expect(readmeTab).toBeVisible();

        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 120, y: 24 } });
        await expect
            .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);
        await pressOptionP(running.page);
        dialog = running.page.getByRole('dialog');
        input = dialog.getByRole('combobox', { name: 'File path' });
        await input.fill('sr');
        await expect(input).toHaveAttribute('aria-busy', 'true');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('ArrowRight');
        await expect(dialog).toContainText('src/');
        await input.fill('nest');
        await expect(input).toHaveAttribute('aria-busy', 'true');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await expect(dialog).toContainText('src/nested/');
        await input.fill('tar');
        await expect(input).toHaveAttribute('aria-busy', 'true');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Tab');
        await expect(input).toHaveValue('target.ts');
        await input.press('Enter');
        await expect(running.page.locator('.work-tab', { hasText: 'target.ts' })).toBeVisible();

        const readmeFileRow = running.page
            .locator('.file-list')
            .getByRole('treeitem', { name: 'README.md', exact: true });
        await readmeFileRow.focus();
        // Deliberately the real Playwright chord rather than `pressOptionP`: CDP delivers
        // `key: 'p'`/`code: 'KeyP'`, which is what a non-composing layout produces, so this covers
        // the genuine input pipeline end to end. The two synthetic dispatches above cover the
        // macOS-composed `key: 'π'` variant the same chord has to survive. Both must resolve to
        // `alt+p`, and only exercising one of them would leave the other free to regress.
        await running.page.keyboard.press('Alt+P');
        dialog = running.page.getByRole('dialog');
        input = dialog.getByRole('combobox', { name: 'File path' });
        await input.fill('sr');
        await expect(input).toHaveAttribute('aria-busy', 'true');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await expect(dialog).toContainText('src/');
        await input.press('ArrowLeft');
        await expect(dialog.getByRole('option', { name: 'src' })).toBeVisible();
        await input.fill('sr');
        await expect(input).toHaveAttribute('aria-busy', 'true');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await input.fill('../');
        await expect(dialog.getByRole('option', { name: 'README.md' })).toBeVisible();
        await input.press('Escape');
        await expect(dialog).toHaveCount(0);

        await running.page.keyboard.press('Meta+Shift+P');
        await expect(running.page.getByRole('dialog')).toContainText('Commands');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('typing a name that does not exist offers to create a file or folder', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-path-browser-create-e2e-'));
    const root = join(testDirectory, 'project');
    const userData = join(testDirectory, 'user-data');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);

        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await pressOptionP(running.page);
        const dialog = running.page.getByRole('dialog');
        const input = dialog.getByRole('combobox', { name: 'File path' });
        await expect(input).toBeFocused();

        // Empty state used to be a dead end ("No matching file or folder."); it now offers to
        // create the typed name, a trailing slash meaning a folder.
        await input.fill('notes.md');
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await expect(dialog.getByRole('option')).toHaveCount(0);
        const fileCreateButton = dialog.getByRole('button', { name: 'Create file' });
        await expect(fileCreateButton).toBeVisible();
        await expect(fileCreateButton).toContainText('notes.md');
        await expect(dialog).toContainText('Enter Create');

        await input.press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'notes.md' })).toBeVisible();
        // Try/catch rather than a bare `readFile`: the create is asynchronous, so the first poll can
        // land before the file exists and an ENOENT rejection would fail the whole assertion
        // instead of retrying.
        await expect
            .poll(async () => {
                try {
                    return await readFile(join(root, 'notes.md'), 'utf8');
                } catch {
                    return;
                }
            })
            .toBe('');

        await pressOptionP(running.page);
        const secondDialog = running.page.getByRole('dialog');
        const secondInput = secondDialog.getByRole('combobox', { name: 'File path' });
        await expect(secondInput).toBeFocused();
        await secondInput.fill('drafts/');
        await expect(secondInput).toHaveAttribute('aria-busy', 'false');
        const folderCreateButton = secondDialog.getByRole('button', { name: 'Create folder' });
        await expect(folderCreateButton).toBeVisible();
        await expect(folderCreateButton).toContainText('drafts');
        await folderCreateButton.click();
        // Creating a folder navigates into it instead of closing the dialog, matching the folder
        // affordance in the existing entry list (`CornerDownLeft`/`ArrowRight`).
        await expect(secondDialog).toBeVisible();
        await expect(secondDialog).toContainText('drafts/');
        await expect(secondInput).toHaveValue('');
        await expect
            .poll(async () => {
                try {
                    const entry = await stat(join(root, 'drafts'));
                    return entry.isDirectory();
                } catch {
                    return false;
                }
            })
            .toBe(true);

        await secondInput.press('Escape');
        await expect(secondDialog).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
