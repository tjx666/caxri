import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

async function initializeRepo(path: string, branch = 'main'): Promise<void> {
    await execFileAsync('mkdir', ['-p', path]);
    await execFileAsync('git', ['init', '-b', branch], { cwd: path });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: path });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: path });
}

async function commit(path: string, message: string): Promise<void> {
    await execFileAsync('git', ['add', '.'], { cwd: path });
    await execFileAsync('git', ['commit', '-m', message], { cwd: path });
}

test('Git repositories lazy-load pageable commits and subtree history', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-commits-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const nested = join(root, 'nested');
    await initializeRepo(root);
    await execFileAsync('mkdir', ['-p', join(root, 'scope')]);
    for (let index = 1; index <= 7; index += 1) {
        const directory = index === 1 || index === 7 ? 'scope' : '.';
        // Each iteration commits on top of the previous one to build a real, ordered Git history;
        // the commits must land sequentially, not concurrently.
        // eslint-disable-next-line no-await-in-loop
        await writeFile(join(root, directory, `commit-${index}.txt`), `${index}\n`, 'utf8');
        // eslint-disable-next-line no-await-in-loop
        await commit(root, index === 7 ? 'latest scoped commit' : `commit ${index}`);
    }
    await initializeRepo(nested, 'nested-main');
    await writeFile(join(nested, 'nested.txt'), 'nested\n', 'utf8');
    await commit(nested, 'nested commit');
    const canonicalRoot = await realpath(root);
    const canonicalNested = await realpath(nested);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const gitTab = running.page.getByRole('tab', { name: 'Source Control', exact: true });
        await gitTab.click();
        await expect(gitTab).toHaveClass(/active/);
        await expect(running.page.locator('.git-repository-section')).toHaveCount(2);
        const primary = running.page.locator('.git-repository-section').filter({
            has: running.page.locator(`.git-repository-row[title="${canonicalRoot}"]`),
        });
        const nestedSection = running.page.locator('.git-repository-section').filter({
            has: running.page.locator(`.git-repository-row[title="${canonicalNested}"]`),
        });
        await expect(primary.locator('.git-repository-kind')).toHaveCount(0);
        await expect(nestedSection.locator('.git-repository-kind')).toHaveText('nested');
        await expect(primary.locator('.git-repository-name')).toHaveCSS('flex-shrink', '0');
        await expect(primary.locator('.git-repository-branch')).toHaveCSS(
            'text-overflow',
            'ellipsis',
        );

        await primary.getByRole('button', { name: /Commits/ }).click();
        await expect(primary.locator('.commit-row')).toHaveCount(5);
        await expect(primary.locator('.commit-row').first()).toContainText('latest scoped commit');
        await expect(primary.locator('.commit-row').first()).toContainText('Caxri Test');
        await expect(primary.locator('.commit-row').first()).toContainText('HEAD -> main');
        await expect(primary.getByRole('button', { name: 'Load more' })).toBeVisible();
        await primary.getByRole('button', { name: 'Load more' }).click();
        await expect(primary.locator('.commit-row')).toHaveCount(7);

        await primary.locator('.commit-row').first().click();
        await expect(primary.locator('.commit-details')).toContainText('Changed files · 1');
        await expect(primary.locator('.commit-details')).toContainText('scope/commit-7.txt');

        // Hovering a commit row raises the GitLens-style preview card with author and sha.
        await primary.locator('.commit-row').first().hover();
        const hoverCard = running.page.locator('.commit-hover-card');
        await expect(hoverCard).toBeVisible();
        await expect(hoverCard).toContainText('Caxri Test');
        await expect(hoverCard).toContainText('latest scoped commit');
        await running.page.keyboard.press('Escape');

        // A changed file opens that commit's read-only diff in a sha-labeled editor tab.
        await primary.locator('.commit-details').getByText('scope/commit-7.txt').click();
        await expect(
            running.page.getByRole('tab', { name: /commit-7\.txt \([0-9a-f]{7}\)/ }),
        ).toBeVisible();
        await expect(running.page.locator('.git-file-diff')).toBeVisible();

        await primary
            .getByRole('textbox', { name: `History path for ${root.split('/').at(-1)}` })
            .fill('scope');
        await expect(primary.locator('.commit-row')).toHaveCount(2);
        await expect(
            primary.locator('.commit-row').filter({ hasText: 'latest scoped commit' }),
        ).toBeVisible();
        await expect(primary.locator('.commit-row').filter({ hasText: 'commit 1' })).toBeVisible();

        await nestedSection.getByRole('button', { name: /Commits/ }).click();
        await expect(nestedSection.locator('.commit-row')).toHaveCount(1);
        await expect(nestedSection.locator('.commit-row')).toContainText('nested commit');
        await expect(primary.locator('.commit-row')).toHaveCount(2);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
