import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

async function expectSyntaxColors(editor: Locator): Promise<void> {
    await expect
        .poll(() =>
            editor
                .locator('.view-lines span')
                .evaluateAll(
                    (spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size,
                ),
        )
        .toBeGreaterThan(1);
}

test('ignore and rc dotfiles open with syntax highlighting', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-dotfile-syntax-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    await Promise.all([
        writeFile(
            join(root, '.gitignore'),
            '# Generated files\nnode_modules/\n!important.generated\nsrc/**/cache?.json\n',
            'utf8',
        ),
        writeFile(
            join(root, '.npmrc'),
            '# Package registry\nregistry=https://registry.npmjs.org\nstrict-ssl=true\nfetch-retries=3\n',
            'utf8',
        ),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: '.gitignore', exact: true }).click();
        const editor = running.page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('important.generated');
        await expectSyntaxColors(editor);

        await running.page.getByRole('treeitem', { name: '.npmrc', exact: true }).click();
        await expect(editor.locator('.view-lines')).toContainText('strict-ssl=true');
        await expectSyntaxColors(editor);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
