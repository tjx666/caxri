import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

/**
 * The editor showing a Session document.
 *
 * Once the workbench goes idle, `warmMonacoEditor` mounts a disposable off-screen editor for `caxri://warmup/editor.js`
 * (`apps/desktop/src/renderer/src/lib/monaco.ts`). A bare `.monaco-editor` locator then matches two elements and fails
 * Playwright's strict mode, so every lookup here is pinned to the Session's document editor.
 */
function documentEditor(page: Page) {
    return page.locator('.monaco-editor[data-uri^="caxri://session/"]');
}

test('Editor import links use each package tsconfig and inherited aliases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-editor-imports-e2e-'));
    const root = join(directory, 'project');
    await Promise.all(
        ['one', 'two', 'shared'].map((name) => mkdir(join(root, name), { recursive: true })),
    );
    await Promise.all([
        writeFile(
            join(root, 'base.json'),
            '{ "compilerOptions": { "paths": { "@/*": ["shared/*"] } } }',
        ),
        writeFile(join(root, 'one/tsconfig.json'), '{ "extends": "../base" }'),
        writeFile(
            join(root, 'two/tsconfig.json'),
            '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }',
        ),
        writeFile(join(root, 'one/first.ts'), "import { value } from '@/value';\n"),
        writeFile(join(root, 'two/second.ts'), "import { value } from '@/value';\n"),
        writeFile(join(root, 'shared/value.ts'), 'export const value = "shared-source";\n'),
        writeFile(join(root, 'two/value.ts'), 'export const value = "package-source";\n'),
    ]);
    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
    });
    try {
        const page = running.page;
        await createProjectSession(page);
        const files = page.getByRole('tree', { name: 'Files', exact: true });
        await files.getByRole('treeitem', { name: 'one', exact: true }).click();
        await files.getByRole('treeitem', { name: 'first.ts', exact: true }).click();
        const importLink = documentEditor(page)
            .locator('.detected-link')
            .filter({ hasText: '@/value' });
        await expect(importLink).toBeVisible();
        await importLink.click({ modifiers: ['Meta'] });
        await expect(
            page.getByRole('navigation', {
                name: 'File breadcrumbs: shared/value.ts',
                exact: true,
            }),
        ).toBeVisible();
        await expect(documentEditor(page).locator('.view-lines')).toContainText('shared-source');
        await page.screenshot({ path: test.info().outputPath('inherited-alias.png') });
        await files.getByRole('treeitem', { name: 'two', exact: true }).click();
        await files.getByRole('treeitem', { name: 'second.ts', exact: true }).click();
        await expect(importLink).toBeVisible();
        await importLink.click({ modifiers: ['Meta'] });
        await expect(
            page.getByRole('navigation', { name: 'File breadcrumbs: two/value.ts', exact: true }),
        ).toBeVisible();
        await expect(documentEditor(page).locator('.view-lines')).toContainText('package-source');
        await page.screenshot({ path: test.info().outputPath('nearest-alias.png') });
        await files.getByRole('treeitem', { name: 'second.ts', exact: true }).click();
        await expect(importLink).toBeVisible();
        await writeFile(
            join(root, 'two/tsconfig.json'),
            '{ "compilerOptions": { "paths": { "@/*": ["../shared/*"] } } }',
        );
        await importLink.click({ modifiers: ['Meta'] });
        await expect(
            page.getByRole('navigation', {
                name: 'File breadcrumbs: shared/value.ts',
                exact: true,
            }),
        ).toBeVisible();
        await expect(documentEditor(page).locator('.view-lines')).toContainText('shared-source');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('Editor package imports open linked declarations read-only and restore that policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-package-imports-e2e-'));
    const root = join(directory, 'project');
    const store = join(directory, 'store', 'fixture-dep');
    const userDataDirectory = join(directory, 'profile');
    await Promise.all([
        mkdir(join(root, 'node_modules'), { recursive: true }),
        mkdir(store, { recursive: true }),
    ]);
    const declaration = 'export declare const value: "dependency-value";\n';
    await Promise.all([
        writeFile(
            join(root, 'main.ts'),
            "import { value } from 'fixture-dep';\nimport { feature } from 'fixture-dep/feature';\n",
        ),
        writeFile(
            join(store, 'package.json'),
            JSON.stringify({
                exports: {
                    '.': { types: './index.d.ts', import: './index.js' },
                    './feature': './feature.js',
                },
            }),
        ),
        writeFile(join(store, 'index.d.ts'), declaration),
        writeFile(join(store, 'index.js'), 'export const value = "runtime-value";\n'),
        writeFile(join(store, 'feature.d.ts'), 'export declare const feature: "feature-type";\n'),
        symlink(store, join(root, 'node_modules', 'fixture-dep')),
    ]);
    let running = await launchCaxri({ userDataDir: userDataDirectory, testRootPath: root });
    try {
        let page = running.page;
        await createProjectSession(page);
        await page
            .getByRole('tree', { name: 'Files', exact: true })
            .getByRole('treeitem', { name: 'main.ts', exact: true })
            .click();
        await documentEditor(page)
            .locator('.detected-link')
            .filter({ hasText: /^fixture-dep$/u })
            .click({ modifiers: ['Meta'] });
        await expect(
            page.getByRole('navigation', {
                name: 'File breadcrumbs: node_modules/fixture-dep/index.d.ts',
                exact: true,
            }),
        ).toBeVisible();
        await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
        await documentEditor(page).click({ position: { x: 120, y: 24 } });
        await page.keyboard.type('replacement');
        await page.keyboard.press('Meta+s');
        await expect(documentEditor(page).locator('.view-lines')).not.toContainText('replacement');
        expect(await readFile(join(store, 'index.d.ts'), 'utf8')).toBe(declaration);
        await page.screenshot({ path: test.info().outputPath('dependency-read-only.png') });
        await running.app.close();
        running = await launchCaxri({ userDataDir: userDataDirectory, testRootPath: root });
        page = running.page;
        await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
        await documentEditor(page).click({ position: { x: 120, y: 24 } });
        await page.keyboard.type('replacement');
        await expect(documentEditor(page).locator('.view-lines')).not.toContainText('replacement');
        const files = page.getByRole('tree', { name: 'Files', exact: true });
        await files.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
        await expect(page.getByText('Read-only', { exact: true })).toHaveCount(0);
        await documentEditor(page).click({ position: { x: 120, y: 24 } });
        await page.keyboard.press('Meta+End');
        await page.keyboard.type('\n// editable-source');
        await page.keyboard.press('Meta+s');
        await expect
            .poll(() => readFile(join(root, 'main.ts'), 'utf8'))
            .toContain('editable-source');
        await documentEditor(page)
            .locator('.detected-link')
            .filter({ hasText: /^fixture-dep\/feature$/u })
            .click({ modifiers: ['Meta'] });
        await expect(
            page.getByRole('navigation', {
                name: 'File breadcrumbs: node_modules/fixture-dep/feature.d.ts',
                exact: true,
            }),
        ).toBeVisible();
        await expect(documentEditor(page).locator('.view-lines')).toContainText('feature-type');
        await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
