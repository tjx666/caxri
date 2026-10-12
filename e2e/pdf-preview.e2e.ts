import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { syntheticPdf } from './support/synthetic-pdf.ts';

/**
 * Find runs through pdf.js's find controller against the document's own text, across pages the viewer has not rendered
 * yet, so only a real PDF in the real viewer proves the count, the cross-page step, and the highlight cleanup.
 */
test('finds text across the pages of a PDF preview', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-pdf-find-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(
        join(root, 'guide.pdf'),
        syntheticPdf(['Alpha needle one', 'Beta needle two needle', 'Gamma page']),
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const { page } = running;
    try {
        await createProjectSession(page);
        await page.getByRole('treeitem', { name: 'guide.pdf', exact: true }).click();
        const pdf = page.getByTestId('pdf-preview');
        await expect(pdf.locator('.textLayer').first()).toContainText('Alpha needle one');
        const pageField = page.getByRole('textbox', { name: 'Page' });
        await expect(pageField).toHaveValue('1');

        await pdf.click();
        await page.keyboard.press('Meta+f');
        const bar = page.getByRole('search', { name: 'Find in PDF' });
        const input = bar.getByRole('textbox', { name: 'Find in PDF' });
        await expect(input).toBeFocused();
        await input.fill('needle');
        await expect(bar).toContainText('1/3');
        await expect(pdf.locator('.highlight.selected')).toHaveCount(1);

        await input.press('Enter');
        await expect(bar).toContainText('2/3');
        await expect(pageField).toHaveValue('2');
        await input.press('Enter');
        await expect(bar).toContainText('3/3');
        await input.press('Shift+Enter');
        await expect(bar).toContainText('2/3');

        await input.fill('absent');
        await expect(bar).toContainText('No results');
        await expect(bar.getByRole('button', { name: 'Next Match' })).toBeDisabled();

        // Reopening keeps the query, and Escape clears every highlight and returns focus to the document.
        await input.fill('needle');
        await expect(bar).toContainText(/\d\/3/u);
        await input.press('Escape');
        await expect(bar).toHaveCount(0);
        await expect(pdf).toBeFocused();
        await expect(pdf.locator('.highlight')).toHaveCount(0);
        await page.keyboard.press('Meta+f');
        await expect(input).toHaveValue('needle');
        await expect(pdf.locator('.highlight').first()).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
