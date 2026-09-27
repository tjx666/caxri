import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

async function gitAt(cwd: string, ...arguments_: string[]): Promise<void> {
    await execFileAsync('git', arguments_, { cwd });
}

async function initialize(root: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await gitAt(root, 'init', '-b', 'main');
    await gitAt(root, 'config', 'user.name', 'Caxri Test');
    await gitAt(root, 'config', 'user.email', 'test@example.com');
    await writeFile(join(root, 'tracked.txt'), 'before\n');
    await gitAt(root, 'add', 'tracked.txt');
    await gitAt(root, 'commit', '-m', 'initial');
}

test('Submodule changes clear automatically after an external commit in a linked worktree', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'caxri-submodule-refresh-e2e-'));
    const directory = await realpath(temporaryDirectory);
    const primary = join(directory, 'primary');
    const root = join(directory, 'linked');
    const source = join(directory, 'source');
    const child = join(root, 'child');
    await initialize(primary);
    await initialize(source);
    await gitAt(primary, 'worktree', 'add', '-b', 'linked', root);
    await gitAt(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child');
    await gitAt(root, 'commit', '-am', 'add child');
    await gitAt(child, 'config', 'user.name', 'Caxri Test');
    await gitAt(child, 'config', 'user.email', 'test@example.com');
    await writeFile(join(child, 'tracked.txt'), 'after\n');
    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const panel = running.page.locator('.git-panel');
        const section = panel.locator('.git-repository-section').filter({
            has: running.page.locator(`.git-repository-row[data-path="${child}"]`),
        });
        const file = section.getByRole('treeitem', { name: 'tracked.txt', exact: true });
        await expect(file).toBeVisible();
        await panel.screenshot({ path: test.info().outputPath('submodule-before-commit.png') });
        await gitAt(child, 'add', 'tracked.txt');
        await gitAt(child, 'commit', '-m', 'commit child change');
        await expect(file).toHaveCount(0);
        await expect(section.getByText('Working tree clean.', { exact: true })).toBeVisible();
        await panel.screenshot({ path: test.info().outputPath('submodule-after-commit.png') });

        // Files names the same repository with the `archive` glyph Source Control gives it, not a folder icon.
        await running.page.getByRole('tab', { name: 'Files', exact: true }).click();
        const childRow = running.page.getByRole('treeitem', { name: 'child', exact: true });
        await expect(childRow.locator('[data-child-repo-icon="submodule"]')).toBeVisible();
        await expect(childRow.locator('[data-file-icon]')).toHaveCount(0);
        await childRow.screenshot({ path: test.info().outputPath('submodule-files-row.png') });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
