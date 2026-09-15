import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

const CODE_BLOCK_SOURCE = 'const answer = 42;\nexport { answer };\n';

const README = [
    '# Preview fixture',
    '',
    '- [x] rendered task',
    '- [ ] pending task',
    '',
    '```ts',
    CODE_BLOCK_SOURCE.trimEnd(),
    '```',
    '',
    '```mermaid',
    'graph LR',
    '  A[Source] --> B[Preview]',
    '```',
    '',
    '![badge](./badge.svg)',
    '',
    'See the [guide](./guide.md).',
    '',
].join('\n');

const BADGE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">' +
    '<rect width="64" height="32" fill="#4f8ef7" rx="4"/></svg>\n';

/**
 * Covers the whole preview pipeline end to end, because none of it can be unit-tested: the engine's HTML only becomes a
 * heading, a highlighted block, a diagram, and an object-URL image after the Renderer decorates the mounted DOM.
 */
test('previews Markdown and SVG in a virtual editor tab', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-preview-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(join(root, 'README.md'), README, 'utf8'),
        writeFile(join(root, 'guide.md'), '# Guide\n', 'utf8'),
        writeFile(join(root, 'badge.svg'), BADGE_SVG, 'utf8'),
    ]);

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
        await expect(running.page.locator('.monaco-editor').first()).toBeVisible();

        await running.page.keyboard.press('Meta+Shift+V');
        const preview = running.page.locator('.caxri-markdown');
        await expect(preview).toBeVisible();
        await expect(preview.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();

        // Task lists, Mermaid, and images are each rendered by a different stage after the HTML mounts.
        await expect(preview.locator('.caxri-markdown-checkbox')).toHaveCount(2);
        await expect(preview.locator('.caxri-markdown-checkbox').first()).toBeChecked();
        await expect(preview.locator('.caxri-markdown-diagram svg')).toBeVisible();
        const image = preview.locator('.caxri-markdown-image');
        await expect(image).toHaveAttribute('src', /^blob:/u);
        await expect
            .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
            .toBe(64);

        // Monaco colorization replaces the escaped source with spans painted from the live theme.
        const code = preview.locator('.caxri-markdown-code code');
        await expect(code.locator('span').first()).toBeVisible();
        await expect(code).toContainText('const answer = 42;');

        await running.clipboard.writeText('BEFORE_COPY');
        await preview.locator('.caxri-markdown-code').hover();
        const copyButton = preview.getByRole('button', { name: 'Copy code block' });
        await expect(copyButton).toBeVisible();
        await copyButton.click();
        await expect.poll(() => running.clipboard.textEquals(CODE_BLOCK_SOURCE)).toBe(true);
        await running.clipboard.claimText(CODE_BLOCK_SOURCE);

        // A link to another previewable document opens its own preview tab rather than navigating this one.
        await preview.getByRole('link', { name: 'guide' }).click();
        await expect(running.page.getByRole('tab', { name: 'Preview: guide.md' })).toBeVisible();
        await expect(preview.getByRole('heading', { name: 'Guide' })).toBeVisible();

        await running.page.getByRole('treeitem', { name: 'badge.svg', exact: true }).click();
        // The command reads the active pane tab, so the source has to be the active one before the chord is sent.
        await expect(running.page.getByRole('tab', { name: 'badge.svg' })).toBeVisible();
        await expect(running.page.locator('.monaco-editor').first()).toContainText('viewBox');
        await running.page.keyboard.press('Meta+Shift+V');
        const imagePreview = running.page.locator('.caxri-image-preview-canvas');
        await expect(imagePreview).toBeVisible();
        await expect(running.page.getByText('64 × 32')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
