import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

test('Editor breadcrumbs browse siblings with one keyboard focus model', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-breadcrumbs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const components = join(root, 'src', 'components');
    const helpers = join(root, 'src', 'helpers');
    const utilityPath = join(helpers, 'utility.ts');
    await Promise.all([
        mkdir(components, { recursive: true }),
        mkdir(helpers, { recursive: true }),
    ]);
    await Promise.all([
        writeFile(join(components, 'current.ts'), 'export const current = true;\n', 'utf8'),
        writeFile(join(components, 'sibling.ts'), 'export const sibling = true;\n', 'utf8'),
        writeFile(utilityPath, 'export const utility = true;\n', 'utf8'),
        symlink(join(components, 'sibling.ts'), join(components, 'linked.ts')),
        ...Array.from({ length: 40 }, (_, index) =>
            writeFile(
                join(components, `a-${String(index).padStart(2, '0')}.ts`),
                `export const item${index} = true;\n`,
                'utf8',
            ),
        ),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const fileList = running.page.locator('.file-list').first();
        await fileList.getByRole('treeitem', { name: 'src', exact: true }).click();
        await fileList.getByRole('treeitem', { name: 'components', exact: true }).click();
        // The tree is virtualized: current.ts sits below 40 siblings, so bring it into the mounted window first.
        await expect(
            fileList.getByRole('treeitem', { name: 'a-00.ts', exact: true }),
        ).toBeVisible();
        await fileList.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await fileList.getByRole('treeitem', { name: 'current.ts', exact: true }).click();

        const breadcrumbs = running.page.getByRole('navigation', {
            name: 'File breadcrumbs: src/components/current.ts',
        });
        await expect(breadcrumbs).toBeVisible();
        const componentsSegment = breadcrumbs.getByRole('button', {
            name: 'Browse src/components',
            exact: true,
        });
        const currentSegment = breadcrumbs.getByRole('button', {
            name: 'Browse src/components/current.ts',
            exact: true,
        });
        await componentsSegment.focus();
        await running.page.keyboard.press('ArrowRight');
        await expect(currentSegment).toBeFocused();
        await running.page.keyboard.press('Escape');
        await expect
            .poll(() =>
                running.page
                    .locator('.monaco-editor')
                    .evaluate((editor) => editor.contains(document.activeElement)),
            )
            .toBe(true);

        await currentSegment.click();
        const componentSiblings = running.page.getByRole('listbox', {
            name: 'Contents of src/components',
        });
        await expect(componentSiblings).toBeFocused();
        await expect(componentSiblings.getByRole('option', { name: 'current.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect
            .poll(() => componentSiblings.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);
        const pointerTarget = componentSiblings.getByRole('option').nth(5);
        await componentSiblings.evaluate((element) => {
            element.scrollTop = 154;
        });
        const scrollTopBeforePointer = await componentSiblings.evaluate(
            (element) => element.scrollTop,
        );
        await pointerTarget.dispatchEvent('pointermove', { pointerType: 'mouse' });
        await expect(pointerTarget).toHaveAttribute('aria-selected', 'true');
        await expect
            .poll(() => componentSiblings.evaluate((element) => element.scrollTop))
            .toBe(scrollTopBeforePointer);
        await componentSiblings.press('Home');
        await expect
            .poll(() => componentSiblings.evaluate((element) => element.scrollTop))
            .toBeLessThan(scrollTopBeforePointer);
        await expect(
            componentSiblings.getByRole('option', {
                name: 'linked.ts',
            }),
        ).not.toHaveAttribute('aria-disabled', 'true');
        await writeFile(join(components, 'created.ts'), 'export const created = true;\n', 'utf8');
        await expect(
            componentSiblings.getByRole('option', { name: 'created.ts', exact: true }),
        ).toBeVisible();
        await running.page.keyboard.press('s');
        await expect(componentSiblings.getByRole('option', { name: 'sibling.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await running.page.keyboard.press('Enter');

        await expect(
            running.page.getByRole('navigation', {
                name: 'File breadcrumbs: src/components/sibling.ts',
            }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('tab', { name: 'current.ts', exact: true }),
        ).toHaveCount(0);
        await expect(
            running.page.getByRole('tab', { name: 'sibling.ts', exact: true }),
        ).toBeVisible();
        await expect(running.page.locator('.monaco-editor .view-lines')).toContainText(
            'export const sibling = true;',
        );
        await expect
            .poll(() =>
                running.page
                    .locator('.monaco-editor')
                    .evaluate((editor) => editor.contains(document.activeElement)),
            )
            .toBe(true);

        await running.page
            .getByRole('button', { name: 'Browse src/components', exact: true })
            .click();
        const sourceSiblings = running.page.getByRole('listbox', { name: 'Contents of src' });
        await sourceSiblings.getByRole('option', { name: 'helpers', exact: true }).click();
        const helperContents = running.page.getByRole('listbox', {
            name: 'Contents of src/helpers',
        });
        await helperContents.getByRole('option', { name: 'utility.ts', exact: true }).click();
        await expect(
            running.page.getByRole('navigation', {
                name: 'File breadcrumbs: src/helpers/utility.ts',
            }),
        ).toBeVisible();
        await expect(running.page.locator('.monaco-editor .view-lines')).toContainText(
            'export const utility = true;',
        );

        const utilityTab = running.page.locator('.work-tab', { hasText: 'utility.ts' });
        await utilityTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Split Right');
        const panes = running.page.locator('.workbench-pane');
        await expect(panes).toHaveCount(2);
        const sourcePane = panes.first();
        await sourcePane.locator('.work-tab[data-terminal-id]').getByRole('tab').click();
        await expect(
            fileList.getByRole('treeitem', { name: 'helpers', exact: true }),
        ).toHaveAttribute('aria-expanded', 'true');
        await fileList.getByRole('treeitem', { name: 'utility.ts', exact: true }).click();
        await expect(panes.locator('.monaco-editor')).toHaveCount(2);
        const sourceBreadcrumb = sourcePane.getByRole('button', {
            name: 'Browse src/helpers/utility.ts',
            exact: true,
        });
        await sourceBreadcrumb.focus();
        await running.page.keyboard.press('Escape');
        await expect
            .poll(() =>
                sourcePane
                    .locator('.monaco-editor')
                    .evaluate((editor) => editor.contains(document.activeElement)),
            )
            .toBe(true);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
