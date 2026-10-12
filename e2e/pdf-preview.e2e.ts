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

/**
 * The password reaches pdf.js only through the form, so the real viewer is the only place to prove that a wrong one is
 * rejected in place and the right one opens the pages.
 */
test('opens a password-protected PDF after the reader enters its password', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-pdf-password-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(
        join(root, 'locked.pdf'),
        syntheticPdf(['Locked page one', 'Locked page two'], { userPassword: 'open-sesame' }),
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const { page } = running;
    try {
        await createProjectSession(page);
        await page.getByRole('treeitem', { name: 'locked.pdf', exact: true }).click();
        await expect(
            page.getByText('This PDF is password-protected. Enter its password to open it.'),
        ).toBeVisible();
        const field = page.getByLabel('Password', { exact: true });
        await expect(field).toBeFocused();
        const open = page.getByRole('button', { name: 'Open', exact: true });
        await expect(open).toBeDisabled();

        await field.fill('wrong');
        await field.press('Enter');
        await expect(
            page.getByRole('alert').filter({ hasText: 'Incorrect password.' }),
        ).toBeVisible();
        await expect(field).toHaveAttribute('aria-invalid', 'true');
        await expect(field).toBeFocused();

        await field.fill('open-sesame');
        await open.click();
        const pdf = page.getByTestId('pdf-preview');
        await expect(pdf.locator('.page')).toHaveCount(2);
        await expect(pdf.locator('.textLayer').first()).toContainText('Locked page one');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
