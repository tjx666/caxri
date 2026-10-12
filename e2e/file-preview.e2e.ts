import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { measurePreviewDecode } from './support/preview-decode-benchmark.ts';
import { syntheticPdf } from './support/synthetic-pdf.ts';

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
    ...Array.from({ length: 30 }, (_, index) => `![image ${index}](./image-${index}.svg)`),
    ...Array.from({ length: 11 }, (_, index) => [
        '```mermaid',
        `graph LR; Source${index} --> Preview${index}`,
        '```',
        '',
    ]).flat(),
    '',
    'See the [guide](./guide.md).',
    '',
    // Raw HTML reaches the preview by design (`<details>`, banners), so the sanitizer is what has to hold here.
    '<details><summary>Kept</summary>inline HTML survives</details>',
    '<style>body { visibility: hidden; }</style>',
    '<script>globalThis.caxriPreviewEscaped = true;</script>',
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
    // The missing-file preview's `files.read` NOT_FOUND is caller-handled, so Server Core logs it at `warn`.
    allowE2EErrors([{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-preview-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(join(root, 'README.md'), README, 'utf8'),
        writeFile(join(root, 'guide.md'), '# Guide\n', 'utf8'),
        writeFile(join(root, 'badge.svg'), BADGE_SVG, 'utf8'),
        ...Array.from({ length: 30 }, (_, index) =>
            writeFile(join(root, `image-${index}.svg`), BADGE_SVG, 'utf8'),
        ),
    ]);

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const decode = await measurePreviewDecode(running.page);
        expect(decode.valid).toBe(true);
        console.log('CAXRI_PREVIEW_DECODE_BENCHMARK', JSON.stringify(decode));
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
        /**
         * `editor.openPreview` reads the active pane tab, and a keystroke sent before that tab is the active one is
         * dropped by the `when` gate with no feedback. Monaco mounts before the layout settles, so waiting for the
         * editor element alone is not enough; wait for the tab and for the document to be painted in it.
         */
        await expect(running.page.getByRole('tab', { name: 'README.md' })).toBeVisible();
        await expect(running.page.locator('.monaco-editor').first()).toContainText(
            'Preview fixture',
        );

        await running.page.keyboard.press('Meta+Shift+V');
        const preview = running.page.locator('.caxri-markdown');
        await expect(preview).toBeVisible();
        await expect(preview.getByRole('heading', { name: 'Preview fixture' })).toBeVisible();

        // Task lists, Mermaid, and images are each rendered by a different stage after the HTML mounts.
        await expect(preview.locator('.caxri-markdown-checkbox')).toHaveCount(2);
        await expect(preview.locator('.caxri-markdown-checkbox').first()).toBeChecked();
        await expect(preview.locator('.caxri-markdown-diagram svg')).toHaveCount(12);
        await expect(preview.locator('.caxri-markdown-image[src^="blob:"]')).toHaveCount(31);
        const image = preview.locator('.caxri-markdown-image').first();
        await expect(image).toHaveAttribute('src', /^blob:/u);
        await expect
            .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
            .toBe(64);

        /**
         * The preview renders inside the Workbench document rather than a separate webview, so a document-supplied
         * `<style>` would restyle the whole application. Useful inline HTML still has to survive that sanitizer.
         */
        await expect(preview.getByText('inline HTML survives')).toBeAttached();
        await expect(preview.locator('script')).toHaveCount(0);
        // Not a bare `style` count: Mermaid's own SVG carries one, scoped to that diagram's generated id.
        expect(
            await running.page.evaluate(() =>
                [...document.querySelectorAll('style')].some((element) =>
                    element.textContent.includes('visibility: hidden'),
                ),
            ),
        ).toBe(false);
        expect(
            await running.page.evaluate(
                () => (globalThis as { caxriPreviewEscaped?: boolean }).caxriPreviewEscaped,
            ),
        ).toBeUndefined();
        expect(await preview.evaluate((element) => getComputedStyle(element).contain)).toContain(
            'paint',
        );

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

        // A file can disappear after its link was rendered but before its preview reads the document.
        await rm(join(root, 'guide.md'));
        await preview.getByRole('link', { name: 'guide' }).click();
        await expect(running.page.getByRole('tab', { name: 'Preview: guide.md' })).toBeVisible();
        const failure = running.page.locator('.empty-work[role="alert"]');
        await expect(failure).toContainText("Couldn't open this file");
        await expect(
            running.page.getByRole('status', { name: 'Loading preview…', exact: true }),
        ).toHaveCount(0);
        await writeFile(join(root, 'guide.md'), '# Guide\n', 'utf8');
        const retry = failure.getByRole('button', { name: 'Retry', exact: true });
        await retry.focus();
        await retry.press('Enter');
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

/**
 * The three formats added beside Markdown each cross the Renderer/Server boundary differently: a PDF is the only
 * preview that opens directly and reads through `files.readAsset` into a pdf.js worker, while CSV and Mermaid render
 * from the same buffer the source tab edits.
 */
test('previews PDF, CSV, and Mermaid files', async () => {
    // Reading `sample.bin` as text is refused and logged in Main and Server Core; the Renderer then opens it as a
    // no-preview tab instead of showing an error.
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'IO', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'IO', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-preview-formats-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(
            join(root, 'manual.pdf'),
            syntheticPdf(['Synthetic page one', 'Synthetic page two']),
        ),
        writeFile(join(root, 'broken.pdf'), 'not a PDF\n', 'utf8'),
        writeFile(
            join(root, 'cities.csv'),
            'city,note,population\n"Lisbon, PT","said ""hi""\nthen left",545000\nOslo,plain,709000\n',
            'utf8',
        ),
        writeFile(join(root, 'flow.mmd'), 'graph LR\n  Draft --> Review\n', 'utf8'),
        writeFile(join(root, 'broken.mmd'), 'graph LR\n  Draft -->\n', 'utf8'),
        writeFile(join(root, 'sample.bin'), Buffer.from([0x89, 0x50, 0x00, 0xff, 0x00, 0x01])),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const { page } = running;
    try {
        await createProjectSession(page);

        await page.getByRole('treeitem', { name: 'manual.pdf', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'manual.pdf', exact: true })).toBeVisible();
        const pdf = page.getByTestId('pdf-preview');
        await expect(pdf.locator('.page')).toHaveCount(2);
        await expect(pdf.locator('.textLayer').first()).toContainText('Synthetic page one');
        const pageField = page.getByRole('textbox', { name: 'Page' });
        await expect(pageField).toHaveValue('1');
        await expect(page.getByText('of 2', { exact: true })).toBeVisible();
        await pageField.fill('2');
        await pageField.press('Enter');
        await expect(pageField).toHaveValue('2');
        const zoom = page.getByRole('button', { name: /^Zoom: \d+%$/u });
        const fitted = await zoom.getAttribute('aria-label');
        await page.getByRole('button', { name: 'Zoom In' }).click();
        await expect(zoom).not.toHaveAttribute('aria-label', fitted ?? '');
        await zoom.click();
        await page.getByRole('menuitemradio', { name: 'Fit Width' }).click();
        await expect(zoom).toHaveAttribute('aria-label', fitted ?? '');

        // Regenerating the file on disk swaps the new copy in without a click, at the reader's page and zoom.
        await page.getByRole('button', { name: 'Zoom In' }).click();
        await expect(zoom).not.toHaveAttribute('aria-label', fitted ?? '');
        const zoomed = await zoom.getAttribute('aria-label');
        await pdf.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(pageField).toHaveValue('2');
        await writeFile(
            join(root, 'manual.pdf'),
            syntheticPdf(['Rewritten page one', 'Rewritten page two', 'Rewritten page three']),
        );
        await expect(pdf.locator('.page')).toHaveCount(3);
        await expect(pdf).toContainText('Rewritten page two');
        await expect(page.getByText('of 3', { exact: true })).toBeVisible();
        await expect(pageField).toHaveValue('2');
        await expect(zoom).toHaveAttribute('aria-label', zoomed ?? '');

        await page.getByRole('treeitem', { name: 'broken.pdf', exact: true }).click();
        await expect(page.locator('.empty-work[role="alert"]')).toContainText(
            'This file is not a valid PDF, or it is damaged.',
        );

        // A binary file has no text to edit: it opens a no-preview tab whose way forward is Finder, not an error toast.
        await page.getByRole('treeitem', { name: 'sample.bin', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'Preview: sample.bin' })).toBeVisible();
        await expect(page.getByText('No preview is available for this file.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Reveal in Finder' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open Source' })).toHaveCount(0);

        await page.getByRole('treeitem', { name: 'cities.csv', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'cities.csv', exact: true })).toBeVisible();
        await expect(page.locator('.monaco-editor').first()).toContainText('population');
        await page.keyboard.press('Meta+Shift+V');
        const table = page.getByRole('table', { name: 'Table preview' });
        await expect(table.getByRole('columnheader', { name: 'population' })).toBeVisible();
        await expect(table.getByRole('cell', { name: 'Lisbon, PT' })).toBeVisible();
        await expect(table.getByRole('row')).toHaveCount(3);
        await expect(page.getByText('2 rows × 3 columns')).toBeVisible();
        // A descending sort on a numeric column keeps each row's source number in the gutter.
        const population = table.getByRole('columnheader', { name: 'population' });
        await population.getByRole('button').click();
        await population.getByRole('button').click();
        await expect(population).toHaveAttribute('aria-sort', 'descending');
        await expect(table.getByRole('row').nth(1)).toContainText('Oslo');
        await expect(table.getByRole('rowheader').first()).toHaveText('2');
        await page.keyboard.press('Meta+F');
        const filter = page.getByRole('textbox', { name: 'Filter rows' });
        await expect(filter).toBeFocused();
        await page.keyboard.type('lisbon');
        await expect(page.getByText('1 of 2 rows × 3 columns')).toBeVisible();
        await expect(table.getByRole('rowheader').first()).toHaveText('1');

        await page.getByRole('treeitem', { name: 'flow.mmd', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'flow.mmd', exact: true })).toBeVisible();
        await expect(page.locator('.monaco-editor').first()).toContainText('Review');
        await page.keyboard.press('Meta+Shift+V');
        await expect(page.getByTestId('mermaid-preview').locator('svg')).toBeVisible();
        await expect(page.getByTestId('mermaid-preview')).toContainText('Review');

        await page.getByRole('treeitem', { name: 'broken.mmd', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'broken.mmd', exact: true })).toBeVisible();
        await expect(page.locator('.monaco-editor').first()).toContainText('Draft');
        await page.keyboard.press('Meta+Shift+V');
        await expect(
            page.getByTestId('mermaid-preview').locator('.caxri-markdown-diagram-error'),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
