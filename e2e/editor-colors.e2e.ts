import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { clickGitGroupAction, createProjectSession, launchCaxri } from './support/helpers.ts';

async function configureRepo(path: string): Promise<void> {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: path });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: path });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: path });
}

test('JSON and gitlink patches use VS Code-style Dracula colors', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-colors-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const submoduleSource = join(testDirectory, 'submodule-source');
    await execFileAsync('mkdir', ['-p', root, submoduleSource]);
    await Promise.all([configureRepo(root), configureRepo(submoduleSource)]);
    await writeFile(
        join(root, 'theme.json'),
        '{\n  "name": "caxri",\n  "enabled": true,\n  "count": 1\n}\n',
        'utf8',
    );
    await execFileAsync('git', ['add', 'theme.json'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(submoduleSource, 'file.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: submoduleSource });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: submoduleSource });
    await execFileAsync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/sub'],
        { cwd: root },
    );
    await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: root });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'advance'], {
        cwd: join(root, 'vendor/sub'),
    });
    await execFileAsync('git', ['add', 'vendor/sub'], { cwd: root });
    /*
     * The parent's change list hides a gitlink row whose submodule already has a repository section of its own, so the
     * staged gitlink alone would leave the parent's group empty and its Open Changes action disabled. A second parent
     * change keeps that action live; the aggregated diff behind it still carries the gitlink patch this test samples.
     */
    await writeFile(join(root, 'notes.txt'), 'gitlink patch coverage\n', 'utf8');
    await execFileAsync('git', ['add', 'notes.txt'], { cwd: root });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'theme.json', exact: true }).click();
        const jsonLine = running.page.locator('.view-line').filter({ hasText: '"name"' });
        await expect(jsonLine).toBeVisible();
        // Tokenization runs asynchronously in the language worker, so poll until the line is
        // split into colored tokens instead of sampling once right after it becomes visible.
        await expect
            .poll(() =>
                jsonLine.locator('span span').evaluateAll((elements) =>
                    elements.map((element) => ({
                        color: getComputedStyle(element).color,
                        text: element.textContent,
                    })),
                ),
            )
            .toEqual(
                expect.arrayContaining([
                    { color: 'rgb(139, 233, 253)', text: '"name"' },
                    { color: 'rgb(241, 250, 140)', text: '"caxri"' },
                ]),
            );
        const booleanLine = running.page.locator('.view-line').filter({ hasText: 'true' });
        await expect(booleanLine.locator('span span').last()).toHaveCSS(
            'color',
            'rgb(255, 121, 198)',
        );
        const numberLine = running.page.locator('.view-line').filter({ hasText: '"count"' });
        await expect(numberLine.locator('span span').last()).toHaveCSS(
            'color',
            'rgb(189, 147, 249)',
        );

        await running.page.getByRole('tab', { name: 'Git', exact: true }).click();
        const primary = running.page.locator('.git-repository-section').filter({
            has: running.page.locator('.git-repository-row', { hasText: 'project' }),
        });
        // The submodule owns a repository section of its own, so the parent's change list drops
        // the gitlink row rather than printing the same submodule twice. The gitlink patch is
        // still reachable through the aggregated Open Changes surface below.
        const submoduleHeader = running.page
            .locator('.git-repository-section')
            .filter({ has: running.page.locator('.git-repository-kind', { hasText: 'submodule' }) })
            .locator('.git-repository-row');
        await expect(submoduleHeader).toHaveAttribute('aria-expanded', 'true');
        await expect(primary.locator('.git-row', { hasText: 'sub' })).toHaveCount(0);

        await clickGitGroupAction(primary, 'Open Changes');
        const gitlinkItem = running.page
            .locator('.git-multi-diff-item')
            .filter({ hasText: 'vendor/sub' });
        // The stacked list virtualizes, so an item only mounts its editor once it nears the viewport.
        await gitlinkItem.scrollIntoViewIfNeeded();
        const patchEditor = gitlinkItem.locator('.git-patch-editor');
        await expect(patchEditor).toBeVisible();
        await expect(patchEditor).toContainText('Subproject commit');
        // A gitlink has no blob pair behind it, so it renders as a patch rather than a Monaco diff.
        await expect(gitlinkItem.locator('.monaco-diff-editor')).toHaveCount(0);

        const removedLine = patchEditor.locator('.view-line').filter({ hasText: '-Subproject' });
        const addedLine = patchEditor.locator('.view-line').filter({ hasText: '+Subproject' });
        await expect(removedLine).toBeVisible();
        await expect(addedLine).toBeVisible();
        await expect(removedLine.locator('span span').first()).toHaveCSS(
            'color',
            'rgb(255, 85, 85)',
        );
        await expect(addedLine.locator('span span').first()).toHaveCSS(
            'color',
            'rgb(80, 250, 123)',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
