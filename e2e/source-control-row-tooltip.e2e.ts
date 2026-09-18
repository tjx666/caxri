import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Source Control file and folder rows do not open a tooltip over the adjacent diff', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-scm-row-tooltip-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(join(root, 'nested'), { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'after\n');
    await writeFile(join(root, 'nested', 'notes.txt'), 'new\n');

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repo = page.locator('.git-repository-section');
        const fileRow = repo.locator('.git-row[data-path="tracked.txt"]');
        const folderRow = repo.locator('.git-tree-directory[data-path="nested"]');
        await fileRow.click();
        await expect(page.locator('.git-file-diff')).toBeVisible();

        await expect(fileRow).not.toHaveAttribute('data-base-ui-tooltip-trigger');
        await expect(folderRow).not.toHaveAttribute('data-base-ui-tooltip-trigger');
        await fileRow.hover();
        await expect(page.locator('.tooltip-popup[data-open]')).toHaveCount(0);
        await folderRow.hover();
        await expect(page.locator('.tooltip-popup[data-open]')).toHaveCount(0);

        const discard = repo.getByRole('button', { name: 'Discard changes in tracked.txt' });
        await fileRow.hover();
        await expect(discard).toBeVisible();
        await discard.hover();
        await expect(page.locator('.tooltip-popup[data-open]')).toContainText('Discard Changes');
        await page.screenshot({
            path: test.info().outputPath('scm-row-no-path-tooltip.png'),
            mask: [page.locator('.xterm')],
        });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
