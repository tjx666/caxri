import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

const trackedCommitted = 'alpha\nbeta\ngamma\ndelta\n';
const trackedWorking = 'alpha\nbeta-changed\ngamma\ndelta\n';

/**
 * Two working diff tabs in one pane share the pane's single Editor slot. The regression this guards let Monaco keep the
 * diff widget it was first mounted with, so re-selecting the tracked tab recomputed its diff against the untracked
 * tab's empty original and rendered the whole file as removed.
 */
test('Switching between two working diff tabs keeps each diff pointed at its own file', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-diff-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.ts'), trackedCommitted, 'utf8');
    await execFileAsync('git', ['add', 'tracked.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.ts'), trackedWorking, 'utf8');
    await writeFile(join(root, 'fresh.ts'), 'fresh-one\nfresh-two\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const page = running.page;
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        await expect(repo.getByRole('button', { name: 'Changes', exact: true })).toBeVisible();

        const diff = page.locator('.git-file-diff');
        const original = diff.locator('.monaco-diff-editor .editor.original');
        const modified = diff.locator('.monaco-diff-editor .editor.modified');
        const deletedLines = diff.locator('.monaco-diff-editor .line-delete');
        const trackedTab = page.getByRole('tab', { name: 'tracked.ts', exact: true });
        const freshTab = page.getByRole('tab', { name: 'fresh.ts', exact: true });

        const expectTrackedDiff = async (): Promise<void> => {
            await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
            await expect(original).toContainText('alpha');
            await expect(original).toContainText('beta');
            await expect(original).toContainText('gamma');
            await expect(original).not.toContainText('beta-changed');
            await expect(original).not.toContainText('fresh-one');
            await expect(modified).toContainText('beta-changed');
            /**
             * Inline layout duplicates the removed line in its gutter; side-by-side layout has one overlay. Either way
             * only one source line changed. A stale model pair instead marks every line of the file removed.
             */
            await expect.poll(() => deletedLines.count()).toBeGreaterThan(0);
            await expect.poll(() => deletedLines.count()).toBeLessThanOrEqual(2);
        };
        const expectFreshDiff = async (): Promise<void> => {
            await expect(diff).toContainText('fresh-one');
            await expect(diff).toContainText('fresh-two');
            await expect(diff).not.toContainText('alpha');
            /**
             * An absent original must not appear as a deleted blank line.
             */
            await expect(diff.locator('.line-delete')).toHaveCount(0);
            await expect(diff.locator('.git-added-line')).not.toHaveCount(0);
            await expect(
                page.getByRole('button', { name: 'Next Change', exact: true }),
            ).toBeEnabled();
            await page.getByRole('button', { name: 'Next Change', exact: true }).click();
            await expect(diff.getByRole('textbox', { name: 'Added file contents' })).toBeFocused();
        };

        await repo.getByRole('button', { name: 'tracked.ts', exact: true }).click();
        await expect(trackedTab).toBeVisible();
        await expectTrackedDiff();

        await repo.getByRole('button', { name: 'fresh.ts', exact: true }).click();
        await expect(freshTab).toBeVisible();
        await expectFreshDiff();

        await trackedTab.click();
        await expectTrackedDiff();

        await freshTab.click();
        await expectFreshDiff();

        await page.setViewportSize({ width: 1000, height: 700 });
        await expectFreshDiff();
        await diff.screenshot({ path: test.info().outputPath('added-file-narrow.png') });

        await page.setViewportSize({ width: 1800, height: 1000 });
        await expectFreshDiff();
        await diff.screenshot({ path: test.info().outputPath('added-file-wide.png') });

        await trackedTab.click();
        await expectTrackedDiff();

        /**
         * A live file can cross between two-sided and all-deleted without changing its tab identity.
         */
        await writeFile(join(root, 'tracked.ts'), '', 'utf8');
        await expect(diff).toContainText('alpha');
        await expect(diff.locator('.git-deleted-line')).not.toHaveCount(0);
        await expect(diff.locator('.line-insert, .git-added-line')).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'Previous Change', exact: true }),
        ).toBeEnabled();
        await page.getByRole('button', { name: 'Previous Change', exact: true }).click();
        await expect(diff.getByRole('textbox', { name: 'Deleted file contents' })).toBeFocused();
        await diff.screenshot({ path: test.info().outputPath('emptied-file.png') });

        await writeFile(join(root, 'tracked.ts'), trackedWorking, 'utf8');
        await expectTrackedDiff();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
