import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from './support/fixtures.ts';

import { createProjectSession, launchCaxri } from './support/helpers.ts';

const execFileAsync = promisify(execFile);

async function configureRepository(path: string): Promise<void> {
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
    await Promise.all([configureRepository(root), configureRepository(submoduleSource)]);
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
        await primary.locator('.git-row', { hasText: 'sub' }).click();
        const patchEditor = running.page.locator('.git-file-diff .git-patch-editor');
        await expect(patchEditor).toBeVisible();
        await expect(patchEditor).toContainText('Subproject commit');
        await expect(running.page.locator('.git-file-diff .monaco-diff-editor')).toHaveCount(0);

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
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
