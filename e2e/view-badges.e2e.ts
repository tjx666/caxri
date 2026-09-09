import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Git badge loads before its panel and follows changes and Workbench Root switches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-view-badges-'));
    const root = join(await realpath(directory), 'owner');
    const worktree = join(await realpath(directory), 'worktree');
    await mkdir(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'before\n');
    await writeFile(join(root, 'example.test.ts'), 'before\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['worktree', 'add', '-b', 'feature/clean', worktree], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'after\n');
    await writeFile(join(root, 'example.test.ts'), 'after\n');

    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root, worktree]) },
    });
    try {
        const gitTab = running.page.getByRole('tab', { name: 'Git', exact: true });
        const badge = gitTab.locator('[data-view-container-badge]');
        await expect(badge).toHaveCount(0);
        await createProjectSession(running.page);
        await expect(badge).toHaveText('2');
        await expect(gitTab).toHaveAccessibleDescription('2 changes');
        await expect(running.page.locator('.git-panel')).toHaveCount(0);
        await running.page
            .getByRole('tablist', { name: 'Secondary Side Bar' })
            .screenshot({ path: test.info().outputPath('git-badge-before-open.png') });

        await writeFile(join(root, 'new.txt'), 'new\n');
        await expect(badge).toHaveText('3');
        await gitTab.click();
        await expect(running.page.locator('.git-panel')).toBeVisible();
        await expect(badge).toHaveText('3');
        await running.page
            .getByRole('combobox', { name: 'Switch Workbench Root from owner, branch main' })
            .click();
        await running.page
            .getByRole('option', { name: 'Authorize another worktree…', exact: true })
            .click();
        const selector = running.page.getByRole('combobox', {
            name: 'Switch Workbench Root from worktree, branch feature/clean',
        });
        await expect(selector).toBeVisible();
        await expect(badge).toHaveCount(0);

        await writeFile(join(worktree, 'new.txt'), 'new\n');
        await expect(badge).toHaveText('1');
        await expect(gitTab).toHaveAccessibleDescription('1 change');
        await writeFile(join(root, 'while-away.txt'), '');
        await selector.click();
        await running.page.getByRole('option', { name: 'owner · main', exact: true }).click();
        await expect(badge).toHaveText('4');
        await running.page
            .getByRole('tablist', { name: 'Secondary Side Bar' })
            .screenshot({ path: test.info().outputPath('git-badge-returned.png') });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
