import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog } from './support/helpers.ts';

test('Files keeps ignored entries browsable while muting and refreshing them', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-ignore-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await Promise.all([
        mkdir(join(root, 'ignored-dir'), { recursive: true }),
        mkdir(join(root, 'src'), { recursive: true }),
    ]);
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    const ignorePath = join(root, '.gitignore');
    await Promise.all([
        writeFile(ignorePath, 'ignored.log\nignored-dir/\ntracked.log\n', 'utf8'),
        writeFile(join(root, 'ignored.log'), 'ignored', 'utf8'),
        writeFile(join(root, 'metadata.log'), 'not ignored yet', 'utf8'),
        writeFile(join(root, 'tracked.log'), 'tracked', 'utf8'),
        writeFile(join(root, 'ignored-dir', 'inside.txt'), 'inside', 'utf8'),
        writeFile(join(root, 'src', 'new.log'), 'not ignored yet', 'utf8'),
    ]);
    await execFileAsync('git', ['add', '--force', 'tracked.log'], { cwd: root });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        await running.page.getByRole('dialog').getByRole('button', { name: 'Shell' }).click();

        const ignored = running.page.getByRole('treeitem', { name: 'ignored.log', exact: true });
        const tracked = running.page.getByRole('treeitem', { name: 'tracked.log', exact: true });
        await expect(ignored).toHaveAttribute('data-git-ignored', 'true');
        await expect(tracked).not.toHaveAttribute('data-git-ignored', 'true');
        expect(await ignored.evaluate((element) => getComputedStyle(element).color)).not.toBe(
            await tracked.evaluate((element) => getComputedStyle(element).color),
        );

        const metadataIgnored = running.page.getByRole('treeitem', {
            name: 'metadata.log',
            exact: true,
        });
        await expect(metadataIgnored).not.toHaveAttribute('data-git-ignored', 'true');
        await writeFile(join(root, '.git', 'info', 'exclude'), 'metadata.log\n', 'utf8');
        await expect(metadataIgnored).toHaveAttribute('data-git-ignored', 'true');

        await running.page.getByRole('treeitem', { name: 'ignored-dir', exact: true }).click();
        await expect(
            running.page.getByRole('treeitem', { name: 'inside.txt', exact: true }),
        ).toBeVisible();

        await running.page.getByRole('treeitem', { name: 'src', exact: true }).click();
        const newlyIgnored = running.page.getByRole('treeitem', { name: 'new.log', exact: true });
        await expect(newlyIgnored).not.toHaveAttribute('data-git-ignored', 'true');
        await writeFile(ignorePath, 'ignored.log\nignored-dir/\ntracked.log\nsrc/*.log\n', 'utf8');
        await expect(newlyIgnored).toHaveAttribute('data-git-ignored', 'true');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
