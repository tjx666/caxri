import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog } from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');

test('Files secondarySidebar renders local file, folder, open, and fallback icons', async () => {
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
        // Both resolve only through VS Code's language registry: an extension (`cjs`) and a filename pattern (`.env.*`).
        writeFile(join(root, '.changelogrc.cjs'), 'module.exports = {};\n', 'utf8'),
        writeFile(join(root, '.env.desktop'), 'KEY=value\n', 'utf8'),
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
        await expect(running.page.locator('[data-file-icon="file_type_js"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="file_type_dotenv"]')).toBeVisible();
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

test('Files secondarySidebar identifies symlinks by their target instead of an untyped placeholder', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-symlinks-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'Component.tsx'), 'export {};\n', 'utf8');
    await Promise.all([
        // `dist` is named for what it is, so it must earn a real folder icon rather than the neutral default.
        symlink('src', join(root, 'dist')),
        // The link's own name carries no type, so only its target can supply one.
        symlink('Component.tsx', join(root, 'link-to-component')),
        symlink('./missing', join(root, 'broken-link')),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        await running.page.getByRole('dialog').getByRole('button', { name: 'Shell' }).click();

        const tree = running.page.getByRole('tree', { name: 'Files' });
        await expect(
            tree.locator('[data-symlink-icon="directory"] [data-file-icon="folder_type_dist"]'),
        ).toBeVisible();
        await expect(
            tree.locator('[data-symlink-icon="file"] [data-file-icon="file_type_reactts"]'),
        ).toBeVisible();
        await expect(
            tree.locator('[data-symlink-icon="broken"] [data-file-icon="default_file"]'),
        ).toBeVisible();

        // A link to a directory belongs with the directories; links to files stay with the files.
        const rowNames = await tree
            .getByRole('treeitem')
            .evaluateAll((rows) =>
                rows.map((row) => row.textContent.split('Symlink', 1)[0].trim()),
            );
        expect(rowNames).toEqual([
            'dist',
            'src',
            'broken-link',
            'Component.tsx',
            'link-to-component',
        ]);

        const directoryLink = tree.getByRole('treeitem').first();
        // The link facts moved from a native `title` to the cursor Tooltip plus this `aria-describedby` text.
        await expect(directoryLink).toHaveAccessibleDescription('Symlink to src.');
        await expect(directoryLink).not.toHaveAttribute('aria-disabled', 'true');
        await expect(directoryLink).toHaveAttribute('aria-expanded', 'false');
        await directoryLink.click();
        await expect(directoryLink).toHaveAttribute('aria-expanded', 'true');
        await directoryLink.press('ArrowLeft');
        await expect(directoryLink).toHaveAttribute('aria-expanded', 'false');
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
