import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

/**
 * Mirrors the `PaneLayout` shape from `packages/protocol/src/domain/pane-layout.ts` closely enough for structural
 * assertions over `app.bootstrap`; kept local (rather than imported) since the fixture only needs the pane/split
 * discriminant and the fields this spec reads.
 */
type BootstrapPaneNode =
    | {
          type: 'pane';
          id: string;
          tabs: Array<{
              id: string;
              resource: { kind: 'file'; path: string } | { kind: 'terminal'; terminalId: string };
          }>;
      }
    | {
          type: 'split';
          id: string;
          direction: 'horizontal' | 'vertical';
          ratio: number;
          first: BootstrapPaneNode;
          second: BootstrapPaneNode;
      };

interface BootstrapSessionState {
    sessionId: string;
    paneLayout?: { root?: BootstrapPaneNode; activePaneId?: string };
}

async function sessionPaneLayoutRoot(page: Page): Promise<BootstrapPaneNode | undefined> {
    const bootstrap = await pageRequest<{ sessionStates: BootstrapSessionState[] }>(
        page,
        'app.bootstrap',
    );
    return bootstrap.sessionStates[0]?.paneLayout?.root;
}

/**
 * File paths held by a pane node, in tab order. Throws on a split node since every call site already knows it is
 * looking at a leaf.
 */
function paneFilePaths(node: BootstrapPaneNode): string[] {
    if (node.type !== 'pane') throw new Error('Expected a pane node, found a split');
    return node.tabs.flatMap((tab) => (tab.resource.kind === 'file' ? [tab.resource.path] : []));
}

/**
 * Opens `name` from the file tree and pins it (double-clicking its Work tab), so it survives the next file open instead
 * of being replaced in the single preview slot — mirrors the open+pin sequence in `editor-tabs.e2e.ts`.
 */
async function openAndPinFile(page: Page, name: string): Promise<Locator> {
    await page.getByRole('treeitem', { name, exact: true }).click();
    const tab = page.locator('.work-tab', { hasText: name });
    await tab.getByRole('tab').dblclick();
    await expect(tab).not.toHaveAttribute('data-preview');
    return tab;
}

/**
 * Splits an existing Work tab into an adjacent pane by exercising the same native HTML5 drag gesture as a user dragging
 * a tab onto one of `pane-view.tsx`'s four edge drop zones. Geometry itself (which edge a given point resolves to) is
 * covered by the `resolvePaneDropZone` unit tests in
 * `apps/desktop/src/renderer/src/features/workbench/__tests__/pane-drop-zone.test.ts`; this only proves the DOM wiring
 * — dragstart on the tab, dragover/drop on the target pane's surface — actually reaches `splitPaneTab`/`movePaneTab`.
 */
async function dragWorkTabToPaneZone(
    page: Page,
    tab: Locator,
    targetPane: Locator,
    { xRatio, yRatio }: { xRatio: number; yRatio: number },
): Promise<void> {
    // The `id` attribute lives on the inner `role="tab"` button (see `work-tab.tsx`), but `draggable` and the
    // `dragstart` listener that populates `PANE_TAB_DRAG_TYPE` are on the outer `.work-tab` element; the drag must
    // start from that ancestor.
    const tabButtonId = await tab.getByRole('tab').getAttribute('id');
    const targetPaneId = await targetPane.getAttribute('data-pane-id');
    if (!tabButtonId || !targetPaneId) throw new Error('Pane split drag fixture is missing an id');
    await page.evaluate(
        ({ tabButtonId: sourceButtonId, targetPaneId: paneId, xRatio: x, yRatio: y }) => {
            const sourceButton = document.querySelector(`#${CSS.escape(sourceButtonId)}`);
            const source = sourceButton?.closest('.work-tab');
            // The actual drop listeners live on `.pane-surface`, the content area beneath a pane's tab bar, not on
            // the outer `.workbench-pane` box.
            const dropTarget = document.querySelector(
                `.workbench-pane[data-pane-id="${CSS.escape(paneId)}"] .pane-surface`,
            );
            if (!source || !dropTarget) throw new Error('Pane split drag fixture not found');
            const transfer = new DataTransfer();
            const bounds = dropTarget.getBoundingClientRect();
            const options = {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + bounds.width * x,
                clientY: bounds.top + bounds.height * y,
                dataTransfer: transfer,
            };
            source.dispatchEvent(new DragEvent('dragstart', options));
            dropTarget.dispatchEvent(new DragEvent('dragenter', options));
            dropTarget.dispatchEvent(new DragEvent('dragover', options));
            dropTarget.dispatchEvent(new DragEvent('drop', options));
            source.dispatchEvent(new DragEvent('dragend', options));
        },
        { tabButtonId, targetPaneId, xRatio, yRatio },
    );
}

test('Split-right via the tab context menu moves the tab and converges on close, surviving restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-split-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    const aPath = join(root, 'a.ts');
    const bPath = join(root, 'b.ts');
    await writeFile(aPath, 'export const a = 1;\n', 'utf8');
    await writeFile(bPath, 'export const b = 2;\n', 'utf8');

    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const aTab = await openAndPinFile(running.page, 'a.ts');
        await openAndPinFile(running.page, 'b.ts');

        const panes = running.page.locator('.workbench-pane');
        await expect(panes).toHaveCount(1);

        await aTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Split Right');

        await expect(panes).toHaveCount(2);
        await expect(running.page.locator('.pane-split.pane-split-horizontal')).toHaveCount(1);
        await expect(
            running.page.getByRole('separator', { name: 'Resize horizontal split' }),
        ).toHaveCount(1);

        // `splitTabIntoPane` moves the occurrence rather than duplicating it: the source pane keeps only b.ts, and
        // the new (right) pane holds only a.ts.
        const splitRoot = await sessionPaneLayoutRoot(running.page);
        expect(splitRoot?.type).toBe('split');
        if (splitRoot?.type !== 'split') throw new Error('Pane layout did not split');
        expect(splitRoot.direction).toBe('horizontal');
        expect(paneFilePaths(splitRoot.first)).toEqual([bPath]);
        expect(paneFilePaths(splitRoot.second)).toEqual([aPath]);

        // Persistence across restart: the split-layout tree, not just the two open tabs, must survive relaunch.
        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        await expect(running.page.locator('.pane-split.pane-split-horizontal')).toHaveCount(1);
        const restoredRoot = await sessionPaneLayoutRoot(running.page);
        expect(restoredRoot?.type).toBe('split');
        if (restoredRoot?.type !== 'split') throw new Error('Pane layout did not restore');
        expect(restoredRoot.direction).toBe('horizontal');
        expect(paneFilePaths(restoredRoot.second)).toEqual([aPath]);
        await expect(
            running.page.locator('.work-tab:not([data-terminal-id])', { hasText: 'a.ts' }),
        ).toHaveCount(1);
        await expect(
            running.page.locator('.work-tab:not([data-terminal-id])', { hasText: 'b.ts' }),
        ).toHaveCount(1);

        // a.ts lives only in the new (right) pane now; closing its one tab removes a.ts entirely and the emptied
        // pane collapses out of the tree.
        const restoredATab = running.page.locator('.work-tab', { hasText: 'a.ts' });
        await restoredATab.hover();
        await restoredATab.locator('.tab-close').click();

        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
        await expect(running.page.locator('.pane-split')).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'a.ts' })).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'b.ts' })).toHaveCount(1);
        const convergedRoot = await sessionPaneLayoutRoot(running.page);
        expect(convergedRoot?.type).toBe('pane');
        expect(convergedRoot?.type === 'pane' && paneFilePaths(convergedRoot)).toEqual([bPath]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Split-down via a dragged tab moves the tab and converges back to a single pane on close', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-split-drag-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    const aPath = join(root, 'a.ts');
    const bPath = join(root, 'b.ts');
    await writeFile(aPath, 'export const a = 1;\n', 'utf8');
    await writeFile(bPath, 'export const b = 2;\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await openAndPinFile(running.page, 'a.ts');
        const bTab = await openAndPinFile(running.page, 'b.ts');

        const panes = running.page.locator('.workbench-pane');
        await expect(panes).toHaveCount(1);
        const originalPane = panes.first();

        // Dropping near the bottom edge (within the 25% edge band from `resolvePaneDropZone`) resolves to the
        // "down" zone.
        await dragWorkTabToPaneZone(running.page, bTab, originalPane, {
            xRatio: 0.5,
            yRatio: 0.92,
        });

        await expect(panes).toHaveCount(2);
        await expect(running.page.locator('.pane-split.pane-split-vertical')).toHaveCount(1);
        await expect(
            running.page.getByRole('separator', { name: 'Resize vertical split' }),
        ).toHaveCount(1);

        // The move leaves a.ts alone in the original pane and b.ts alone in the new (bottom) pane.
        const splitRoot = await sessionPaneLayoutRoot(running.page);
        expect(splitRoot?.type).toBe('split');
        if (splitRoot?.type !== 'split') throw new Error('Pane layout did not split');
        expect(splitRoot.direction).toBe('vertical');
        expect(paneFilePaths(splitRoot.first)).toEqual([aPath]);
        expect(paneFilePaths(splitRoot.second)).toEqual([bPath]);

        // The new (bottom) pane holds only b.ts; closing its tab removes b.ts entirely and the empty pane
        // collapses, converging the tree back to a single pane.
        const newPaneTab = running.page.locator('.work-tab', { hasText: 'b.ts' });
        /**
         * Pane mounts outlive the split that created them for a frame, so the retiring pane can still expose its copy
         * of the moved tab. Await the single surviving tab before hovering it.
         */
        await expect(newPaneTab).toHaveCount(1);
        await newPaneTab.hover();
        await newPaneTab.locator('.tab-close').click();

        await expect(panes).toHaveCount(1);
        await expect(running.page.locator('.pane-split')).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'b.ts' })).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'a.ts' })).toHaveCount(1);
        const convergedRoot = await sessionPaneLayoutRoot(running.page);
        expect(convergedRoot?.type).toBe('pane');
        expect(convergedRoot?.type === 'pane' && paneFilePaths(convergedRoot)).toEqual([aPath]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
