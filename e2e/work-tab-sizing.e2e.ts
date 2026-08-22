import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ElectronApplication, Page } from 'playwright';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

/**
 * Closes the Electron app during teardown without letting an already-closed app fail the test.
 */
async function closeAppQuietly(app: ElectronApplication): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

/**
 * A quit Terminal writes its shell-integration files asynchronously, so the teardown `rm` below can race a session that
 * just closed and see `ENOTEMPTY`. Mirrors `removeQuitTestDirectory` in `terminal-shortcuts.e2e.ts`.
 */
async function removeQuitTestDirectory(path: string): Promise<void> {
    await expect
        .poll(async () => {
            try {
                await rm(path, { recursive: true, force: true });
                return true;
            } catch (error) {
                if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    Reflect.get(error, 'code') === 'ENOTEMPTY'
                )
                    return false;
                throw error;
            }
        })
        .toBe(true);
}

/**
 * A tab's width tweens in over `--motion-tab-enter`; reading geometry before it settles catches a tab mid-animation
 * (e.g. still short of its final content-sized width), which is what makes drop-position math computed from that
 * geometry land on the wrong neighbor. Mirrors `tabMotionSettleMs` in `editor-tabs.e2e.ts`.
 */
async function waitForTabMotionToSettle(page: Page): Promise<void> {
    const settleMs = await page.evaluate(() => {
        const raw = getComputedStyle(document.documentElement)
            .getPropertyValue('--motion-tab-enter')
            .trim();
        // eslint-disable-next-line unicorn/prefer-number-coercion -- `raw` carries a unit suffix ("300ms"/"0.3s"), which `Number()` cannot parse
        return raw.endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1_000;
    });
    await page.waitForTimeout(settleMs + 50);
}

test('Terminal tabs fill the bar, Document tabs size to content, and the bar scrolls once both overflow', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-mixed-width-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    const fileNames = ['a-short.ts', 'b-much-longer-document-name.ts'];
    for (const name of fileNames) {
        // eslint-disable-next-line no-await-in-loop -- sequential fixture writes, order does not matter but simplicity does
        await writeFile(join(root, name), '', 'utf8');
    }

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const strip = running.page.locator('.work-tabs');
        const scrollRail = running.page.locator('.work-tab-scroll');
        const terminalTabs = strip.locator('.work-tab[data-terminal-id]');
        const documentTabs = strip.locator('.work-tab:not([data-terminal-id])');

        for (const name of fileNames) {
            // eslint-disable-next-line no-await-in-loop -- each open depends on the file tree settling from the previous one
            await running.page.getByRole('treeitem', { name, exact: true }).dblclick();
        }
        await expect(documentTabs).toHaveCount(2);
        await waitForTabMotionToSettle(running.page);

        // Document tabs stay bounded to their own content (ADR 0002 "Tab sizing": 50-160px, VS Code's
        // tabSizingFixed range) regardless of how much room a single Terminal tab leaves on the bar.
        const documentWidths = await documentTabs.evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().width),
        );
        for (const width of documentWidths) {
            expect(width).toBeGreaterThanOrEqual(50);
            expect(width).toBeLessThanOrEqual(160);
        }
        const terminalWidth = await terminalTabs
            .first()
            .evaluate((element) => element.getBoundingClientRect().width);
        expect(terminalWidth).toBeGreaterThan(160);
        expect(
            await scrollRail.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeLessThanOrEqual(1);

        // Terminals are the high-frequency case, so enough of them push the bar past its own width; once
        // that happens the whole rail scrolls instead of every tab shrinking below its own floor. The default
        // window is wide enough that 9 Terminal tabs alone would not overflow it, so narrow the viewport first.
        await running.page.setViewportSize({ width: 900, height: 700 });
        const newTerminal = running.page.getByRole('button', { name: 'New Terminal' });
        for (let index = 0; index < 8; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- each click depends on the previous tab's enter animation settling
            await newTerminal.click();
        }
        await expect(terminalTabs).toHaveCount(9);
        await waitForTabMotionToSettle(running.page);

        expect(
            await scrollRail.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeGreaterThan(1);
        const minTerminalWidth = await terminalTabs.evaluateAll((elements) =>
            Math.min(...elements.map((element) => element.getBoundingClientRect().width)),
        );
        expect(minTerminalWidth).toBeGreaterThanOrEqual(79);
        // The "+" action stays reachable outside the scrolling rail no matter how far it has scrolled.
        await expect(running.page.getByRole('button', { name: 'New Terminal' })).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await removeQuitTestDirectory(testDirectory);
    }
});

test('dragging a work tab within its pane bar drops it at the pointed-at position, not always the end', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-reorder-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    const fileNames = ['a.ts', 'b.ts', 'c.ts'];
    for (const name of fileNames) {
        // eslint-disable-next-line no-await-in-loop -- sequential fixture writes, order does not matter but simplicity does
        await writeFile(join(root, name), '', 'utf8');
    }

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        for (const name of fileNames) {
            // eslint-disable-next-line no-await-in-loop -- each open depends on the file tree settling from the previous one
            await running.page.getByRole('treeitem', { name, exact: true }).dblclick();
        }
        const documentTabs = running.page.locator('.work-tabs .work-tab:not([data-terminal-id])');
        await expect(documentTabs).toHaveCount(3);
        await waitForTabMotionToSettle(running.page);
        const orderedNames = () =>
            documentTabs.evaluateAll((elements) =>
                elements.map((element) => element.querySelector('.tab-label')?.textContent ?? ''),
            );
        await expect.poll(orderedNames).toEqual(['a.ts', 'b.ts', 'c.ts']);

        // Drag c.ts (currently last) to the left quarter of a.ts's own tab, i.e. ahead of every document tab.
        const source = documentTabs.filter({ hasText: 'c.ts' });
        const target = documentTabs.filter({ hasText: 'a.ts' });
        const sourceButtonId = await source.getByRole('tab').getAttribute('id');
        const targetBounds = await target.evaluate((element) => element.getBoundingClientRect());
        if (!sourceButtonId) throw new Error('Work tab drag fixture is missing an id');
        await running.page.evaluate(
            ({ sourceButtonId: id, dropX, dropY }) => {
                const sourceButton = document.querySelector(`#${CSS.escape(id)}`);
                const source = sourceButton?.closest('.work-tab');
                const bar = document.querySelector('[data-pane-tab-bar]');
                if (!source || !bar) throw new Error('Work tab reorder drag fixture not found');
                const transfer = new DataTransfer();
                const options = {
                    bubbles: true,
                    cancelable: true,
                    clientX: dropX,
                    clientY: dropY,
                    dataTransfer: transfer,
                };
                source.dispatchEvent(new DragEvent('dragstart', options));
                bar.dispatchEvent(new DragEvent('dragenter', options));
                bar.dispatchEvent(new DragEvent('dragover', options));
                bar.dispatchEvent(new DragEvent('drop', options));
                source.dispatchEvent(new DragEvent('dragend', options));
            },
            {
                sourceButtonId,
                dropX: targetBounds.x + targetBounds.width * 0.25,
                dropY: targetBounds.y + targetBounds.height / 2,
            },
        );

        await expect.poll(orderedNames).toEqual(['c.ts', 'a.ts', 'b.ts']);
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('dragging a work tab over a sibling shows an insertion-line indicator and previews it after a hover delay', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-drag-preview-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    const fileNames = ['a.ts', 'b.ts', 'c.ts'];
    for (const name of fileNames) {
        // eslint-disable-next-line no-await-in-loop -- sequential fixture writes, order does not matter but simplicity does
        await writeFile(join(root, name), '', 'utf8');
    }

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        for (const name of fileNames) {
            // eslint-disable-next-line no-await-in-loop -- each open depends on the file tree settling from the previous one
            await running.page.getByRole('treeitem', { name, exact: true }).dblclick();
        }
        const documentTabs = running.page.locator('.work-tabs .work-tab:not([data-terminal-id])');
        await expect(documentTabs).toHaveCount(3);
        await waitForTabMotionToSettle(running.page);

        // c.ts opened last, so it is the active tab; hovering a drag of it over a.ts is what should
        // trigger both the insertion-line indicator and the delayed preview switch.
        const source = documentTabs.filter({ hasText: 'c.ts' });
        const target = documentTabs.filter({ hasText: 'a.ts' });
        const sourceButtonId = await source.getByRole('tab').getAttribute('id');
        const targetButtonId = await target.getByRole('tab').getAttribute('id');
        const targetBounds = await target.evaluate((element) => element.getBoundingClientRect());
        if (!sourceButtonId || !targetButtonId)
            throw new Error('Work tab drag fixture is missing an id');

        await running.page.evaluate(
            ({ sourceButtonId: id, targetButtonId: targetId, dropX, dropY }) => {
                const sourceButton = document.querySelector(`#${CSS.escape(id)}`);
                const source = sourceButton?.closest('.work-tab');
                const targetButton = document.querySelector(`#${CSS.escape(targetId)}`);
                const target = targetButton?.closest('.work-tab');
                const bar = document.querySelector('[data-pane-tab-bar]');
                if (!source || !target || !bar)
                    throw new Error('Work tab drag preview fixture not found');
                const transfer = new DataTransfer();
                const options = {
                    bubbles: true,
                    cancelable: true,
                    clientX: dropX,
                    clientY: dropY,
                    dataTransfer: transfer,
                };
                source.dispatchEvent(new DragEvent('dragstart', options));
                // Dispatched on the target tab itself (not the bar) so `event.target` matches what a
                // real cursor-driven drag would report — the app's hover-preview switch reads it to
                // resolve which tab is being hovered, mirroring `dropEdge` in `use-project-order.ts`.
                target.dispatchEvent(new DragEvent('dragenter', options));
                target.dispatchEvent(new DragEvent('dragover', options));
            },
            {
                sourceButtonId,
                targetButtonId,
                dropX: targetBounds.x + targetBounds.width * 0.25,
                dropY: targetBounds.y + targetBounds.height / 2,
            },
        );

        const marker = running.page.locator('.work-tab-drop-marker');
        await expect(marker).toBeVisible();
        const markerLeft = await marker.evaluate((element) => element.getBoundingClientRect().left);
        expect(Math.abs(markerLeft - targetBounds.x)).toBeLessThanOrEqual(2);

        await expect(target.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
        await expect(source.getByRole('tab')).toHaveAttribute('aria-selected', 'false');

        await running.page.evaluate(() => {
            document
                .querySelector('[data-pane-tab-bar]')
                ?.dispatchEvent(
                    new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }),
                );
        });
        await expect(marker).toBeHidden();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
