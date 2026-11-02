import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

async function moveOnto(row: Locator): Promise<number> {
    const box = await row.boundingBox();
    if (!box) throw new Error('File tree row has no layout box');
    const x = box.x + 40;
    await row.page().mouse.move(x, box.y + box.height / 2);
    return x;
}

/**
 * Base UI opens a sibling trigger's tooltip instantly while a popup is open or its delay group is warm, which made a
 * sweep through tree rows flash a tooltip on every row. Like VS Code Explorer rows, each row must wait out its own
 * delay. The interval is measured inside the page from pointer-enter to popup mount, so a slow runner only lengthens it
 * and cannot fake a pass.
 */
test('a Files row tooltip waits for its own delay after a sibling row tooltip was shown', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-file-tree-tooltip-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root);
    await Promise.all([
        writeFile(join(root, 'alpha.txt'), 'alpha\n'),
        writeFile(join(root, 'beta.txt'), 'beta\n'),
    ]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const tree = page.getByRole('tree', { name: 'Files' });
        const alpha = tree.getByRole('treeitem', { name: /^alpha\.txt/ });
        const beta = tree.getByRole('treeitem', { name: /^beta\.txt/ });
        await expect(beta).toBeVisible();

        await moveOnto(alpha);
        await expect(page.locator('.tooltip-popup[data-open]')).toContainText('alpha.txt');

        // A handle, so the listeners are installed before the pointer moves.
        const restProbe = await beta.evaluateHandle((row) => ({
            interval: new Promise<number>((resolve) => {
                let enteredAt: number | undefined;
                row.addEventListener('pointerenter', () => (enteredAt = performance.now()), {
                    once: true,
                });
                const observer = new MutationObserver(() => {
                    const open = document.querySelector('.tooltip-popup[data-open]');
                    if (enteredAt === undefined || !open?.textContent.includes('beta.txt')) {
                        return;
                    }
                    observer.disconnect();
                    resolve(performance.now() - enteredAt);
                });
                observer.observe(document.body, {
                    attributes: true,
                    characterData: true,
                    childList: true,
                    subtree: true,
                });
            }),
        }));
        const pointerX = await moveOnto(beta);
        const popup = page.locator('.tooltip-popup[data-open]');
        await expect(popup).toContainText('beta.txt');
        expect(await restProbe.evaluate((probe) => probe.interval)).toBeGreaterThanOrEqual(400);
        // The deferred open still anchors beside the pointer (flipped to its left near the window edge) rather than
        // centered under the row.
        const popupBox = await popup.boundingBox();
        if (!popupBox) throw new Error('Tooltip popup has no layout box');
        const gap = Math.min(
            Math.abs(popupBox.x - pointerX),
            Math.abs(popupBox.x + popupBox.width - pointerX),
        );
        expect(gap).toBeLessThan(30);
        await page.screenshot({ path: test.info().outputPath('file-tree-row-tooltip.png') });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
