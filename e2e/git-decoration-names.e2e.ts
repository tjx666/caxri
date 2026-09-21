import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('Search and breadcrumbs show the same exact-file Git decoration as Files', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-decoration-names-e2e-'));
    const root = join(testDirectory, 'project');
    const source = join(root, 'src');
    await mkdir(source, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(source, 'dirty.txt'), 'Needle before\n');
    await writeFile(join(source, 'clean.txt'), 'Needle clean\n');
    await execFileAsync('git', ['add', 'src'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(source, 'dirty.txt'), 'Needle after\n');
    await writeFile(join(source, 'fresh.txt'), 'Needle fresh\n');

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        const fileList = running.page.locator('.file-list').first();
        await fileList.getByRole('treeitem', { name: 'src', exact: true }).click();
        const dirtyFile = fileList.getByRole('treeitem', { name: 'dirty.txt', exact: true });
        await expect(dirtyFile.locator('.status-modified')).toHaveText('M');
        await expect(dirtyFile).toHaveAccessibleDescription('Git: modified.');
        await fileList.screenshot({ path: test.info().outputPath('files-comparison.png') });
        await dirtyFile.click();

        const breadcrumbs = running.page.getByRole('navigation', {
            name: 'File breadcrumbs: src/dirty.txt',
        });
        const fileSegment = breadcrumbs.getByRole('button', {
            name: 'Browse src/dirty.txt',
            exact: true,
        });
        const directorySegment = breadcrumbs.getByRole('button', {
            name: 'Browse src',
            exact: true,
        });
        await expect(fileSegment.locator('.truncate.text-git-modified')).toHaveText('dirty.txt');
        await expect(fileSegment.locator('.status-modified')).toHaveText('M');
        await expect(fileSegment).toHaveAccessibleDescription('Git: modified.');
        await expect(directorySegment.locator('.status')).toHaveCount(0);
        await expect(directorySegment.locator('.text-git-modified')).toHaveCount(0);
        await breadcrumbs.screenshot({ path: test.info().outputPath('breadcrumb-file.png') });

        await fileSegment.click();
        const picker = running.page.getByRole('listbox', { name: 'Contents of src' });
        const dirtyOption = picker.getByRole('option', { name: 'dirty.txt', exact: true });
        const freshOption = picker.getByRole('option', { name: 'fresh.txt', exact: true });
        const cleanOption = picker.getByRole('option', { name: 'clean.txt', exact: true });
        await expect(dirtyOption.locator('.status-modified')).toHaveText('M');
        await expect(dirtyOption).toHaveAccessibleDescription('Git: modified.');
        await expect(freshOption.locator('.status-untracked')).toHaveText('?');
        await expect(freshOption).toHaveAccessibleDescription('Git: untracked.');
        await expect(cleanOption.locator('.status')).toHaveCount(0);
        await picker.screenshot({ path: test.info().outputPath('breadcrumb-picker.png') });
        await running.page.keyboard.press('Escape');

        await running.page.keyboard.press('Meta+Shift+F');
        // Content is the default mode; this case is about the decoration on a name result.
        await running.page.getByRole('button', { name: 'Name', exact: true }).click();
        const nameSearch = running.page.getByRole('combobox', { name: 'Find Project files' });
        await nameSearch.fill('.txt');
        const nameResults = running.page.locator('.search-results');
        const dirtyName = nameResults.locator('.search-result[title$="dirty.txt"]');
        const freshName = nameResults.locator('.search-result[title$="fresh.txt"]');
        const cleanName = nameResults.locator('.search-result[title$="clean.txt"]');
        await expect(dirtyName.locator('.truncate.text-git-modified')).toHaveText('dirty.txt');
        await expect(dirtyName.locator('.status-modified')).toHaveText('M');
        await expect(dirtyName).toHaveAccessibleDescription('Git: modified.');
        await expect(freshName.locator('.status-untracked')).toHaveText('?');
        await expect(cleanName.locator('.status')).toHaveCount(0);
        await nameResults.screenshot({ path: test.info().outputPath('search-results.png') });

        await running.page.getByRole('button', { name: 'Content', exact: true }).click();
        await running.page
            .getByRole('combobox', { name: 'Search Project contents' })
            .fill('Needle');
        const dirtyGroup = running.page.locator('.search-result-group[title="src/dirty.txt"]');
        await expect(dirtyGroup.locator('.status-modified')).toHaveText('M');
        await expect(dirtyGroup.getByRole('button').first()).toHaveAccessibleDescription(
            'Git: modified.',
        );
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
