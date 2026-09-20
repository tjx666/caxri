import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

async function openProjectFile(
    page: Page,
    directories: string[],
    filePrefix: string,
): Promise<void> {
    await page.keyboard.press('Meta+P');
    const dialog = page.getByRole('dialog');
    const input = dialog.getByRole('combobox', { name: 'File path' });
    /* eslint-disable no-await-in-loop -- each directory must load before the next one can be entered */
    for (const [index, directory] of directories.entries()) {
        await input.fill(directory);
        await expect(input).toHaveAttribute('aria-busy', 'false');
        await input.press('Enter');
        await expect(dialog).toContainText(`${directories.slice(0, index + 1).join('/')}/`);
    }
    /* eslint-enable no-await-in-loop */
    await input.fill(filePrefix);
    await expect(input).toHaveAttribute('aria-busy', 'false');
    await input.press('Tab');
    await input.press('Enter');
    await expect(dialog).toHaveCount(0);
}

test('Files reveals the active Editor file without stealing focus or switching panels', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-auto-reveal-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await Promise.all([
        mkdir(join(root, 'alpha'), { recursive: true }),
        mkdir(join(root, 'z-target', 'deep'), { recursive: true }),
        ...Array.from({ length: 28 }, (_, index) =>
            mkdir(join(root, `folder-${String(index).padStart(2, '0')}`), { recursive: true }),
        ),
    ]);
    await Promise.all([
        writeFile(join(root, 'alpha', 'other.ts'), 'export const other = true;\n', 'utf8'),
        writeFile(
            join(root, 'z-target', 'deep', 'reveal.ts'),
            'export const revealed = true;\n',
            'utf8',
        ),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const secondarySidebarTabs = running.page.getByRole('tablist', {
            name: 'Secondary Side Bar',
        });
        const filesTab = secondarySidebarTabs.getByRole('tab', { name: 'Files', exact: true });
        const gitTab = secondarySidebarTabs.getByRole('tab', { name: 'Git', exact: true });
        const tree = running.page.getByRole('tree', { name: 'Files' });

        await openProjectFile(running.page, ['z-target', 'deep'], 'reve');
        const revealTab = running.page
            .locator('.work-tab', { hasText: 'reveal.ts' })
            .getByRole('tab');
        await expect(revealTab).toBeVisible();
        await revealTab.dblclick();
        await expect(tree.getByRole('treeitem', { name: 'z-target', exact: true })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await expect(tree.getByRole('treeitem', { name: 'deep', exact: true })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        const revealRow = tree.getByRole('treeitem', { name: 'reveal.ts', exact: true });
        await expect(revealRow).toHaveAttribute('aria-selected', 'true');
        await expect(revealRow).toBeInViewport();
        await expect
            .poll(() => tree.evaluate((element) => element.contains(document.activeElement)))
            .toBe(false);

        await gitTab.click();
        await openProjectFile(running.page, ['alpha'], 'oth');
        const otherTab = running.page
            .locator('.work-tab', { hasText: 'other.ts' })
            .getByRole('tab');
        await expect(otherTab).toBeVisible();
        await otherTab.dblclick();
        await expect(gitTab).toHaveAttribute('aria-selected', 'true');
        await expect(filesTab).toHaveAttribute('aria-selected', 'false');

        await filesTab.click();
        const otherRow = tree.getByRole('treeitem', { name: 'other.ts', exact: true });
        await expect(otherRow).toHaveAttribute('aria-selected', 'true');
        await expect(otherRow).toBeInViewport();

        await running.page.getByRole('button', { name: 'Collapse Folders' }).click();
        await expect(otherRow).toHaveCount(0);
        await revealTab.click();
        await expect(revealRow).toHaveAttribute('aria-selected', 'true');
        await expect(revealRow).toBeInViewport();
        await expect(revealTab).toBeFocused();
        await expect(tree.getByRole('treeitem', { name: 'alpha', exact: true })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
