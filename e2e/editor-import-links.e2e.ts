import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

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
        const importLink = page
            .locator('.monaco-editor .detected-link')
            .filter({ hasText: '@/value' });
        await expect(importLink).toBeVisible();
        await importLink.click({ modifiers: ['Meta'] });
        await expect(
            page.getByRole('navigation', {
                name: 'File breadcrumbs: shared/value.ts',
                exact: true,
            }),
        ).toBeVisible();
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('shared-source');
        await page.screenshot({ path: test.info().outputPath('inherited-alias.png') });
        await files.getByRole('treeitem', { name: 'two', exact: true }).click();
        await files.getByRole('treeitem', { name: 'second.ts', exact: true }).click();
        await expect(importLink).toBeVisible();
        await importLink.click({ modifiers: ['Meta'] });
        await expect(
            page.getByRole('navigation', { name: 'File breadcrumbs: two/value.ts', exact: true }),
        ).toBeVisible();
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('package-source');
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
        await expect(page.locator('.monaco-editor .view-lines')).toContainText('shared-source');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
