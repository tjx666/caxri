import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { launchCaxri, openAddProjectDialog } from './helpers.ts';

const execFileAsync = promisify(execFile);

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

        const ignored = running.page.getByRole('button', { name: 'ignored.log', exact: true });
        const tracked = running.page.getByRole('button', { name: 'tracked.log', exact: true });
        await expect(ignored).toHaveAttribute('data-git-ignored', 'true');
        await expect(tracked).not.toHaveAttribute('data-git-ignored', 'true');
        expect(await ignored.evaluate((element) => getComputedStyle(element).color)).not.toBe(
            await tracked.evaluate((element) => getComputedStyle(element).color),
        );

        const metadataIgnored = running.page.getByRole('button', {
            name: 'metadata.log',
            exact: true,
        });
        await expect(metadataIgnored).not.toHaveAttribute('data-git-ignored', 'true');
        await writeFile(join(root, '.git', 'info', 'exclude'), 'metadata.log\n', 'utf8');
        await expect(metadataIgnored).toHaveAttribute('data-git-ignored', 'true');

        await running.page.getByRole('button', { name: 'ignored-dir', exact: true }).click();
        await expect(
            running.page.getByRole('button', { name: 'inside.txt', exact: true }),
        ).toBeVisible();

        await running.page.getByRole('button', { name: 'src', exact: true }).click();
        const newlyIgnored = running.page.getByRole('button', { name: 'new.log', exact: true });
        await expect(newlyIgnored).not.toHaveAttribute('data-git-ignored', 'true');
        await writeFile(ignorePath, 'ignored.log\nignored-dir/\ntracked.log\nsrc/*.log\n', 'utf8');
        await expect(newlyIgnored).toHaveAttribute('data-git-ignored', 'true');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
