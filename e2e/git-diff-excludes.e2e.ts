import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    clickGitGroupAction,
    createProjectSession,
    launchCaxri,
    openSettingsTab,
} from './support/helpers.ts';

test('Git diff exclusions hide changes, reveal on demand, and refresh from Settings', async () => {
    const testInfo = test.info();
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-diff-excludes-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'before\n', 'utf8');
    await writeFile(join(root, 'example.test.ts'), 'export const value = "before";\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md', 'example.test.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'example.test.ts'), 'export const value = "committed";\n', 'utf8');
    await execFileAsync('git', ['commit', '-am', 'test-only change'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'after\n', 'utf8');
    await writeFile(join(root, 'example.test.ts'), 'export const value = "after";\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();

        const gitPanel = running.page.locator('.git-panel');
        const repo = gitPanel.locator('.git-repository-section');
        const files = repo.locator('.git-files');
        const excludedFile = files.locator('.git-row[data-path="example.test.ts"]');
        const readme = files.locator('.git-row[data-path="README.md"]');
        const showExcluded = gitPanel.getByRole('button', { name: /^Show excluded files/ });

        await expect(readme).toBeVisible();
        await expect(excludedFile).toHaveCount(0);
        await expect(showExcluded).toHaveAccessibleName(/^Show excluded files \(1\)$/);
        await gitPanel.screenshot({ path: testInfo.outputPath('git-diff-excluded-files.png') });
        const commits = repo.getByRole('treeitem', { name: /Commits/ });
        await commits.click();
        await repo.locator('.commit-row').first().click();
        const historyDetails = repo.locator('.commit-details');
        await expect(historyDetails).toContainText('Changed files · 1 · 1 hidden');
        await expect(historyDetails).toContainText('1 file changed · 1 hidden');
        await expect(historyDetails).not.toContainText('No files in this scope.');
        await historyDetails.screenshot({
            path: testInfo.outputPath('git-history-excluded-files.png'),
        });
        await commits.click();

        await clickGitGroupAction(repo, 'Open Changes');
        const aggregateItems = running.page.locator('.git-multi-diff-item');
        await expect(aggregateItems).toHaveCount(1);
        await expect(aggregateItems.filter({ hasText: 'README.md' })).toHaveCount(1);
        await expect(aggregateItems.filter({ hasText: 'example.test.ts' })).toHaveCount(0);

        await showExcluded.click();
        const hideExcluded = gitPanel.getByRole('button', { name: /^Hide excluded files/ });
        await expect(hideExcluded).toHaveAccessibleName(/^Hide excluded files \(1\)$/);
        await expect(excludedFile).toBeVisible();

        await clickGitGroupAction(repo, 'Open Changes');
        await expect(aggregateItems).toHaveCount(2);
        await expect(aggregateItems.filter({ hasText: 'README.md' })).toHaveCount(1);
        await expect(aggregateItems.filter({ hasText: 'example.test.ts' })).toHaveCount(1);

        await hideExcluded.click();
        await expect(excludedFile).toHaveCount(0);
        await expect(readme).toBeVisible();

        /**
         * Close diff consumers before replacing the fixture's working-tree state.
         */
        const closeEditors = running.page.getByRole('button', {
            name: 'Close Editor',
            exact: true,
        });
        for (let remaining = await closeEditors.count(); remaining > 0; remaining -= 1) {
            // eslint-disable-next-line no-await-in-loop -- tab close controls are revealed by hovering their owner.
            await running.page.locator('.work-tab').filter({ has: closeEditors }).first().hover();
            // eslint-disable-next-line no-await-in-loop -- closing each tab changes the following tab positions.
            await closeEditors.first().click();
            // eslint-disable-next-line no-await-in-loop -- wait for the closing tab to leave before resolving the next one.
            await expect(closeEditors).toHaveCount(remaining - 1);
        }
        await expect(aggregateItems).toHaveCount(0);
        await writeFile(join(root, 'README.md'), 'before\n', 'utf8');
        const refresh = gitPanel.getByRole('button', { name: 'Refresh Git', exact: true });
        await expect(refresh).toBeEnabled();
        await refresh.click();
        await expect(repo.getByText('1 excluded file hidden.', { exact: true })).toBeVisible();
        await expect(repo.getByText('Working tree clean.', { exact: true })).toHaveCount(0);

        const firstSettingsTab = await openSettingsTab(running.page);
        await firstSettingsTab.getByLabel('Search settings').fill('Excluded Git diff files');
        const firstSettingRow = firstSettingsTab.locator('[data-setting-row="git.diffExclude"]');
        await expect(
            firstSettingRow.getByRole('group', { name: 'Excluded Git diff files', exact: true }),
        ).toBeVisible();
        const patterns = firstSettingRow.getByRole('list', { name: 'Excluded file patterns' });
        await expect(patterns.locator('li')).toHaveCount(4);
        for (const pattern of ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/locales/**']) {
            // eslint-disable-next-line no-await-in-loop -- each removal re-renders the same persisted Settings row.
            await firstSettingRow
                .getByRole('button', {
                    name: `Remove excluded pattern ${pattern}`,
                    exact: true,
                })
                .click();
        }
        await expect(patterns.locator('li')).toHaveCount(0);
        // Settings is a Workbench tab now, not a modal (issue caxri#1289): `Cmd+W` closes it
        // outright, forcing the fresh mount this test needs below; otherwise reopening would just
        // re-show the same still-mounted, already-empty list, proving nothing about whether the
        // removals actually persisted rather than only updating local UI state.
        await running.page.keyboard.press('Meta+w');
        await expect(firstSettingsTab).toHaveCount(0);

        await expect(excludedFile).toBeVisible();
        await expect(gitPanel.getByRole('button', { name: /^Show excluded files/ })).toHaveCount(0);

        const settingsTab = await openSettingsTab(running.page);
        await settingsTab.getByLabel('Search settings').fill('Excluded Git diff files');
        const settingRow = settingsTab.locator('[data-setting-row="git.diffExclude"]');
        await expect(
            settingRow.getByRole('list', { name: 'Excluded file patterns' }).locator('li'),
        ).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('The shipped exclusions hide translation catalogs and keep the source that drove them', async () => {
    const testInfo = test.info();
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-locales-excludes-e2e-'));
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', join(root, 'locales', 'zh-CN')], { cwd: testDirectory });
    await execFileAsync('mkdir', ['-p', join(root, 'packages', 'locales', 'src')]);
    await execFileAsync('mkdir', ['-p', join(root, 'packages', 'runtime', 'src')]);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    /**
     * The two shapes a localized repository actually has: generated catalogs at the root and the workspace package that
     * declares them. One product change rewrites both, and neither is what a reviewer opens.
     */
    const catalog = join(root, 'locales', 'zh-CN', 'runtime.json');
    const declaration = join(root, 'packages', 'locales', 'src', 'runtime.ts');
    const source = join(root, 'packages', 'runtime', 'src', 'index.ts');
    await writeFile(catalog, '{ "title": "before" }\n', 'utf8');
    await writeFile(declaration, 'export const title = "before";\n', 'utf8');
    await writeFile(source, 'export const runtime = "before";\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(catalog, '{ "title": "after" }\n', 'utf8');
    await writeFile(declaration, 'export const title = "after";\n', 'utf8');
    await writeFile(source, 'export const runtime = "after";\n', 'utf8');

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const gitPanel = page.locator('.git-panel');
        const files = gitPanel.locator('.git-repository-section .git-files');
        await expect(
            files.locator('.git-row[data-path="packages/runtime/src/index.ts"]'),
        ).toBeVisible();
        await expect(files.locator('.git-row[data-path="locales/zh-CN/runtime.json"]')).toHaveCount(
            0,
        );
        await expect(
            files.locator('.git-row[data-path="packages/locales/src/runtime.ts"]'),
        ).toHaveCount(0);
        const showExcluded = gitPanel.getByRole('button', { name: /^Show excluded files/ });
        await expect(showExcluded).toHaveAccessibleName(/^Show excluded files \(2\)$/);
        await gitPanel.screenshot({ path: testInfo.outputPath('git-locales-excluded.png') });
        await showExcluded.click();
        await expect(
            files.locator('.git-row[data-path="locales/zh-CN/runtime.json"]'),
        ).toBeVisible();
        await expect(
            files.locator('.git-row[data-path="packages/locales/src/runtime.ts"]'),
        ).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
