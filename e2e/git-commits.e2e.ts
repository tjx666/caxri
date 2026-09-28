import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

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
    const nested = join(root, 'nested-repository-with-a-long-name');
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
    await initializeRepo(nested, 'feat/nested-repository-long-branch-name');
    await writeFile(join(nested, 'nested.txt'), 'nested\n', 'utf8');
    await commit(nested, 'nested commit');
    const canonicalRoot = await realpath(root);
    const canonicalNested = await realpath(nested);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const gitTab = running.page.getByRole('tab', { name: 'Git', exact: true });
        await gitTab.click();
        await expect(gitTab).toHaveClass(/active/);
        await expect(running.page.locator('.git-repository-section')).toHaveCount(2);
        const primary = running.page.locator('.git-repository-section').filter({
            has: running.page.locator(`.git-repository-row[data-path="${canonicalRoot}"]`),
        });
        const nestedSection = running.page.locator('.git-repository-section').filter({
            has: running.page.locator(`.git-repository-row[data-path="${canonicalNested}"]`),
        });
        await expect(primary.locator('.git-repository-kind')).toHaveCount(0);
        await expect(nestedSection.locator('.git-repository-kind')).toHaveText('nested');
        // Repository identity must remain recognizable when long labels compete with metadata.
        const identityIcons = nestedSection.locator('.git-repository-identity > svg');
        expect(
            await identityIcons.nth(0).evaluate((icon) => icon.getBoundingClientRect().width),
        ).toBe(13);
        // The repository glyph matches the Project Status tree's own 14px rows.
        expect(
            await identityIcons.nth(1).evaluate((icon) => icon.getBoundingClientRect().width),
        ).toBe(14);
        await running.page
            .locator('.git-panel')
            .screenshot({ path: test.info().outputPath('repository-icons.png') });
        await expect(primary.locator('.git-repository-name')).toHaveCSS(
            'text-overflow',
            'ellipsis',
        );
        await expect(primary.locator('.git-repository-branch')).toHaveCSS(
            'text-overflow',
            'ellipsis',
        );
        // Counts are stated nowhere else on the row, so a long name must ellipsize rather than push them out. A clean
        // repository renders no counts at all, which trivially fits.
        const countsFit = await primary
            .locator('.git-repository-row')
            .first()
            .evaluate((row) => {
                const counts = row.querySelector('.git-repository-counts');
                if (!counts) return true;
                return (
                    counts.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1
                );
            });
        expect(countsFit).toBe(true);
        // The branch is the section's first child row, so neither it nor the name shrinks to make room for the other.
        const nestedLayout = await nestedSection.evaluate((section) => {
            const header = section.querySelector(':scope .git-repository-row');
            const branchRow = section.querySelector(':scope .git-repository-branch-row');
            if (!(header instanceof HTMLElement) || !(branchRow instanceof HTMLElement))
                return null;
            const caption = section.querySelector(':scope .git-changes-caption [role="treeitem"]');
            return {
                headerHasBranch: header.querySelector('.git-repository-branch') !== null,
                headerBottom: header.getBoundingClientRect().bottom,
                branchTop: branchRow.getBoundingClientRect().top,
                branchRowLevel: branchRow.getAttribute('aria-level'),
                branchIconLeft: branchRow.querySelector('svg')?.getBoundingClientRect().left,
                captionIconLeft: caption?.querySelector('svg')?.getBoundingClientRect().left,
            };
        });
        expect(nestedLayout).not.toBeNull();
        expect(nestedLayout!.headerHasBranch).toBe(false);
        expect(nestedLayout!.branchTop).toBeGreaterThanOrEqual(nestedLayout!.headerBottom - 1);
        expect(nestedLayout!.branchRowLevel).toBe('2');
        // The branch glyph sits in the group captions' chevron column.
        if (nestedLayout!.captionIconLeft !== undefined)
            expect(
                Math.abs(nestedLayout!.branchIconLeft! - nestedLayout!.captionIconLeft),
            ).toBeLessThanOrEqual(1);

        await primary.getByRole('treeitem', { name: /Commits/ }).click();
        await expect(primary.locator('.commit-row')).toHaveCount(5);
        await expect(primary.locator('.commit-row').first()).toContainText('latest scoped commit');
        await expect(primary.locator('.commit-row').first()).toContainText('Caxri Test');
        await expect(primary.locator('.commit-row').first()).toContainText('HEAD -> main');
        await expect(primary.getByRole('treeitem', { name: 'Load more' })).toBeVisible();
        await primary.getByRole('treeitem', { name: 'Load more' }).click();
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

        await nestedSection.getByRole('treeitem', { name: /Commits/ }).click();
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

test('File History follows the active editor and opens a committed file diff', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-history-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await initializeRepo(root);
    await writeFile(join(root, 'empty'), 'before\n', 'utf8');
    await commit(root, 'add tracked file');
    await writeFile(join(root, 'empty'), 'after\n', 'utf8');
    await commit(root, 'update tracked file');
    const nested = join(root, 'nested');
    await initializeRepo(nested, 'nested-main');
    await execFileAsync('mkdir', ['-p', join(nested, 'src')]);
    await writeFile(join(nested, 'src', 'nested.txt'), 'nested before\n', 'utf8');
    await commit(nested, 'add nested file');
    await writeFile(join(nested, 'src', 'nested.txt'), 'nested after\n', 'utf8');
    await commit(nested, 'update nested file');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const repositories = running.page.locator('.git-repositories');
        await expect(repositories.locator(':scope > .file-history-section')).toHaveCount(0);

        await running.page.getByRole('tab', { name: 'Files', exact: true }).click();
        await running.page.getByRole('treeitem', { name: 'empty', exact: true }).dblclick();
        const rootFileTab = running.page.getByRole('tab', { name: 'empty', exact: true });
        await expect(rootFileTab).toBeVisible();
        const fileList = running.page.locator('.file-list').first();
        await fileList.getByRole('treeitem', { name: 'nested', exact: true }).click();
        await fileList.getByRole('treeitem', { name: 'src', exact: true }).click();
        await fileList.getByRole('treeitem', { name: 'nested.txt', exact: true }).dblclick();
        const nestedTab = running.page.getByRole('tab', { name: 'nested.txt', exact: true });
        await expect(nestedTab).toBeVisible();
        await rootFileTab.click();

        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const fileHistory = repositories.locator(':scope > .file-history-section');
        await expect(fileHistory).toHaveCount(1);
        await expect(repositories.locator(':scope > .git-repository-section')).toHaveCount(2);
        await expect(repositories.locator(':scope > section').first()).toHaveClass(
            /file-history-section/,
        );
        await expect(fileHistory.getByRole('treeitem', { name: /File History/ })).toContainText(
            'empty',
        );
        await expect(fileHistory.locator('.commit-row')).toHaveCount(0);

        await fileHistory.getByRole('treeitem', { name: /File History/ }).click();
        await expect(fileHistory.locator('.commit-row')).toHaveCount(2);
        await expect(fileHistory.locator('.commit-row').first()).toContainText(
            'update tracked file',
        );

        await nestedTab.click();
        const nestedFileHistory = repositories.locator(':scope > .file-history-section');
        await expect(
            nestedFileHistory.getByRole('treeitem', { name: 'File History: src/nested.txt' }),
        ).toHaveAttribute('aria-expanded', 'true');
        await expect(nestedFileHistory.locator('.commit-row')).toHaveCount(2);
        await expect(nestedFileHistory.locator('.commit-row').first()).toContainText(
            'update nested file',
        );
        await expect(nestedFileHistory).not.toContainText('update tracked file');

        await rootFileTab.click();
        const rootFileHistory = repositories.locator(':scope > .file-history-section');
        await expect(
            rootFileHistory.getByRole('treeitem', { name: 'File History: empty' }),
        ).toHaveAttribute('aria-expanded', 'true');
        await expect(rootFileHistory.locator('.commit-row').first()).toContainText(
            'update tracked file',
        );
        await rootFileHistory.locator('.commit-row').first().click();
        await expect(
            running.page.getByRole('tab', { name: /empty \([0-9a-f]{7}\)/ }),
        ).toBeVisible();
        await expect(running.page.locator('.git-file-diff')).toBeVisible();

        await expect(repositories.locator(':scope > .file-history-section')).toHaveCount(0);

        await rootFileTab.click();
        await expect(
            repositories.getByRole('treeitem', { name: 'File History: empty' }),
        ).toHaveAttribute('aria-expanded', 'true');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
