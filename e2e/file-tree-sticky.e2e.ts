import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog } from './support/helpers.ts';

const ANCESTORS = ['level-1', 'level-2', 'level-3'];
const ROW_HEIGHT = 28;

const LEAF_COUNT = 400;

test('Files tree virtualizes rows and keeps ancestor directories pinned while their subtree scrolls', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-tree-sticky-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const deepest = join(root, ...ANCESTORS);
    await mkdir(deepest, { recursive: true });
    // Enough leaves that the deepest directory alone overflows the panel many times over, so the ancestors must scroll
    // away and only a window of rows may be mounted.
    await Promise.all(
        Array.from({ length: LEAF_COUNT }, (_, index) =>
            writeFile(
                join(deepest, `leaf-${String(index).padStart(3, '0')}.ts`),
                'export {};\n',
                'utf8',
            ),
        ),
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await openAddProjectDialog(running.page);
        await running.page.getByRole('dialog').getByRole('button', { name: 'Shell' }).click();

        const tree = running.page.getByRole('tree', { name: 'Files' });
        for (const ancestor of ANCESTORS) {
            // eslint-disable-next-line no-await-in-loop -- each level must render before the next one can be clicked.
            await tree.getByRole('treeitem', { name: ancestor, exact: true }).click();
        }
        const firstLeaf = tree.getByRole('treeitem', { name: 'leaf-000.ts', exact: true });
        await expect(firstLeaf).toBeVisible();
        // Virtualized: a screenful plus overscan is mounted, not all 403 rows.
        expect(await tree.getByRole('treeitem').count()).toBeLessThan(100);

        await tree.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        // Proves the tree really scrolled: the leaf that used to sit under the ancestors is gone.
        await expect(firstLeaf).not.toBeInViewport();

        const treeBox = await tree.boundingBox();
        if (treeBox === null) throw new Error('The Files tree is not laid out.');
        /**
         * The pinned ancestors are an overlay of visual duplicates, hidden from the accessibility tree.
         */
        const stickyRow = (ancestor: string) =>
            tree.locator(`.file-tree-sticky-row[data-path$="/${ancestor}"]`);
        const ancestorBoxes = await Promise.all(
            ANCESTORS.map(async (ancestor) => {
                const row = stickyRow(ancestor);
                await expect(row).toBeInViewport();
                return row.boundingBox();
            }),
        );
        for (const [index, box] of ancestorBoxes.entries()) {
            if (box === null) throw new Error(`The ${ANCESTORS[index]} row is not laid out.`);
            // Each ancestor stays stacked one row below the previous one at the top of the panel.
            expect(Math.abs(box.y - treeBox.y - index * ROW_HEIGHT)).toBeLessThan(1.5);
        }

        // The overlay's bottom edge carries a shadow, so rows passing under it do not read as overlapping text.
        expect(
            await tree
                .locator('.file-tree-sticky-shadow')
                .evaluate((element) => getComputedStyle(element).boxShadow),
        ).not.toBe('none');
        await running.page.screenshot({ path: test.info().outputPath('file-tree-sticky.png') });

        // Clicking a pinned ancestor scrolls its real row back into place and focuses it, as VS Code does.
        await stickyRow('level-3').click();
        const level3 = tree.getByRole('treeitem', { name: 'level-3', exact: true });
        await expect(level3).toBeFocused();
        await expect(level3).toBeInViewport();

        // End reaches a row that was never mounted, through the row model rather than the DOM.
        await running.page.keyboard.press('End');
        const lastLeaf = tree.getByRole('treeitem', {
            name: `leaf-${String(LEAF_COUNT - 1).padStart(3, '0')}.ts`,
            exact: true,
        });
        await expect(lastLeaf).toBeFocused();
        await expect(lastLeaf).toBeInViewport();

        // The title bar's New File targets the root from any scroll position; its field must mount and take focus.
        const caption = running.page.locator('.panel-caption');
        await caption.hover();
        await caption.getByRole('button', { name: 'New File' }).click();
        const newFileName = running.page.getByRole('textbox', { name: 'New file name' });
        await expect(newFileName).toBeFocused();
        await expect(newFileName).toBeInViewport();
        await newFileName.press('Escape');
        await expect(newFileName).toBeHidden();
        // Revealing the root field scrolled to the top; return to the bottom, where level-3 is pinned again.
        await tree.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });

        // Collapsing releases the pin: the directory scrolls with its siblings again.
        await stickyRow('level-3').click();
        await level3.click();
        await expect(firstLeaf).toBeHidden();
        await expect(tree.locator('.file-tree-sticky-row')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
