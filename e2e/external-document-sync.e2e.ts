import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

const BADGE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">' +
    '<rect width="64" height="32" fill="#4f8ef7" rx="4"/></svg>\n';

function notes(heading: string): string {
    return [
        `# ${heading}`,
        '',
        '![badge](./assets/badge.svg)',
        '',
        'See the [guide](./guide.md).',
        '',
    ].join('\n');
}

/**
 * A file opened from outside every Project follows another app's edits and previews its relative images and links
 * (issue #1566). Only a real Main watcher, Renderer event, and preview asset read prove that wiring together.
 */
test('an external document reloads after another app edits it and previews its own folder', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-external-document-sync-e2e-'));
    const root = join(testDirectory, 'project');
    const externalRoot = join(testDirectory, 'external');
    const userData = join(testDirectory, 'user-data');
    const notesPath = join(externalRoot, 'notes.md');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(join(externalRoot, 'assets'), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(notesPath, notes('First version'), 'utf8'),
        writeFile(join(externalRoot, 'guide.md'), '# External guide\n', 'utf8'),
        writeFile(join(externalRoot, 'assets', 'badge.svg'), BADGE_SVG, 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.locator('.xterm-helper-textarea').focus();
        await running.page.keyboard.press('Meta+P');
        const dialog = running.page.getByRole('dialog');
        const input = dialog.getByRole('combobox', { name: 'File path' });
        await expect(input).toBeFocused();
        await input.press('Backspace');
        await input.fill(`${externalRoot}/notes`);
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await expect(dialog.getByRole('option', { name: 'notes.md', exact: true })).toBeVisible();
        await input.press('Enter');
        await expect(dialog).toHaveCount(0);

        const notesTab = running.page.getByRole('tab', { name: 'notes.md', exact: true });
        await expect(notesTab).toHaveAttribute('aria-selected', 'true');
        const editor = running.page.locator('.monaco-editor').first();
        await expect(editor).toContainText('First version');

        await writeFile(notesPath, notes('Second version from another app'), 'utf8');
        await expect(editor).toContainText('Second version from another app');

        await running.page.keyboard.press('Meta+Shift+V');
        const preview = running.page.locator('.caxri-markdown');
        await expect(
            preview.getByRole('heading', { name: 'Second version from another app' }),
        ).toBeVisible();
        const image = preview.locator('.caxri-markdown-image').first();
        await expect(image).toHaveAttribute('src', /^blob:/u);
        await expect
            .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
            .toBe(64);

        // The preview renders the buffer, so another edit on disk reaches it through the same reload.
        await writeFile(notesPath, notes('Third version'), 'utf8');
        await expect(preview.getByRole('heading', { name: 'Third version' })).toBeVisible();
        await running.page.screenshot({
            path: test.info().outputPath('external-document-preview.png'),
            mask: [running.page.locator('.terminal-surface')],
        });

        await preview.getByRole('link', { name: 'guide' }).click();
        await expect(
            running.page.getByRole('tab', { name: 'guide.md', exact: true }),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
