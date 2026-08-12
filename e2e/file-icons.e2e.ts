import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from './fixtures.ts';

import { launchCaxri, openAddProjectDialog } from './helpers.ts';

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
        writeFile(join(root, 'LICENSE'), 'unknown extensionless file\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        await running.page.getByRole('dialog').getByRole('button', { name: 'Shell' }).click();

        await expect(running.page.locator('[data-file-icon="folder-github"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="folder-src"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="nodejs"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="testTypeScript"]')).toBeVisible();
        await expect(running.page.locator('[data-file-icon="file"]')).toBeVisible();

        await running.page.getByRole('button', { name: '.github', exact: true }).click();
        await expect(running.page.locator('[data-file-icon="folder-github-open"]')).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Renderer build and package manifest include file-icon assets and attribution', async () => {
    const assets = await readdir(join(projectRoot, 'out', 'renderer', 'assets'));
    expect(
        assets.some((file) => file.startsWith('folder-github-open-') && file.endsWith('.svg')),
    ).toBe(true);
    expect(assets.some((file) => file.startsWith('typescript-') && file.endsWith('.svg'))).toBe(
        true,
    );

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        build: { files: string[] };
    };
    expect(packageJson.build.files).toContain('licenses/**');
    await expect(
        readFile(join(projectRoot, 'licenses', 'LOBEHUB_FILE_ICONS_LICENSE.txt'), 'utf8'),
    ).resolves.toContain('Copyright (c) 2023 LobeHub');
});
