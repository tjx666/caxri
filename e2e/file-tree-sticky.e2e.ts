import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog } from './support/helpers.ts';

const ANCESTORS = ['level-1', 'level-2', 'level-3'];
const ROW_HEIGHT = 28;

test('Files tree keeps ancestor directories pinned while their subtree scrolls', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-tree-sticky-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const deepest = join(root, ...ANCESTORS);
    await mkdir(deepest, { recursive: true });
    // Enough leaves that the deepest directory alone overflows the panel, so the ancestors must scroll away.
    await Promise.all(
        Array.from({ length: 60 }, (_, index) =>
            writeFile(
                join(deepest, `leaf-${String(index).padStart(2, '0')}.ts`),
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
        const firstLeaf = tree.getByRole('treeitem', { name: 'leaf-00.ts', exact: true });
        await expect(firstLeaf).toBeVisible();

        await tree.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        // Proves the tree really scrolled: the leaf that used to sit under the ancestors is gone.
        await expect(firstLeaf).not.toBeInViewport();

        const treeBox = await tree.boundingBox();
        if (treeBox === null) throw new Error('The Files tree is not laid out.');
        const ancestorBoxes = await Promise.all(
            ANCESTORS.map(async (ancestor) => {
                const row = tree.getByRole('treeitem', { name: ancestor, exact: true });
                await expect(row).toBeInViewport();
                return row.boundingBox();
            }),
        );
        for (const [index, box] of ancestorBoxes.entries()) {
            if (box === null) throw new Error(`The ${ANCESTORS[index]} row is not laid out.`);
            // Each ancestor stays stacked one row below the previous one at the top of the panel.
            expect(Math.abs(box.y - treeBox.y - index * ROW_HEIGHT)).toBeLessThan(1.5);
        }

        // Collapsing releases the pin: the directory scrolls with its siblings again.
        await tree.getByRole('treeitem', { name: 'level-3', exact: true }).click();
        await expect(firstLeaf).toBeHidden();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
