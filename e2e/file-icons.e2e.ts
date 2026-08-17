import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog } from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');

test('Files inspector renders local file, folder, open, and fallback icons', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-icons-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await Promise.all([
        mkdir(join(root, '.github'), { recursive: true }),
        mkdir(join(root, 'src'), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(join(root, 'package.json'), '{}\n', 'utf8'),
        writeFile(join(root, 'Component.test.tsx'), 'export {};\n', 'utf8'),
        // vscode-icons has no mapping for this name, so it exercises the default_file fallback.
        writeFile(join(root, 'mystery.unknownext'), 'unknown extension file\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        await running.page.getByRole('dialog').getByRole('button', { name: 'Shell' }).click();

        await expect(running.page.locator('[data-file-icon="folder_type_github"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="folder_type_src"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="file_type_npm"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="file_type_testts"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="default_file"]')).toBeVisible();

        await running.page.getByRole('treeitem', { name: '.github', exact: true }).click();
        await expect(
            running.page.locator('[data-file-icon="folder_type_github_opened"]'),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Renderer build and package manifest include file-icon assets and attribution', async () => {
    // The vscode-icons SVGs are shipped verbatim through the renderer publicDir copy (electron.vite.config.ts),
    // not as hashed bundle assets, so they land at out/renderer/icons/<name>.svg.
    const icons = await readdir(join(projectRoot, 'out', 'renderer', 'icons'));
    expect(icons).toContain('folder_type_github_opened.svg');
    expect(icons).toContain('file_type_typescript.svg');
    expect(icons).toContain('default_file.svg');

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        build: { files: string[] };
    };
    expect(packageJson.build.files).toContain('licenses/**');
    await expect(
        readFile(join(projectRoot, 'licenses', 'VSCODE_ICONS_ASSETS_LICENSE.txt'), 'utf8'),
    ).resolves.toContain('Attribution-ShareAlike 4.0 International');
});
