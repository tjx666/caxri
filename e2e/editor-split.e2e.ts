import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

const execFileAsync = promisify(execFile);

/**
 * Mirrors the `EditorLayout` shape from `src/shared/editor-layout.ts` closely enough for structural assertions over
 * `app.bootstrap`; kept local (rather than imported) since the fixture only needs the group/split discriminant and the
 * fields this spec reads.
 */
type BootstrapEditorLayoutNode =
    | { type: 'group'; id: string; paths: string[]; activePath?: string }
    | {
          type: 'split';
          id: string;
          direction: 'horizontal' | 'vertical';
          ratio: number;
          first: BootstrapEditorLayoutNode;
          second: BootstrapEditorLayoutNode;
      };

interface BootstrapSessionState {
    sessionId: string;
    editorLayout?: { root?: BootstrapEditorLayoutNode; activeGroupId?: string };
}

async function sessionEditorLayoutRoot(page: Page): Promise<BootstrapEditorLayoutNode | undefined> {
    const bootstrap = await pageRequest<{ sessionStates: BootstrapSessionState[] }>(
        page,
        'app.bootstrap',
    );
    return bootstrap.sessionStates[0]?.editorLayout?.root;
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
 * Splits an existing Editor tab into an adjacent group by exercising the same native HTML5 drag gesture as a user
 * dragging a Work tab onto one of `editor-layout-view.tsx`'s four edge drop zones. Geometry itself (which edge a given
 * point resolves to) is covered by the `resolveEditorDropZone` unit tests in
 * `src/renderer/src/features/editor/editor-drop-zone.test.ts`; this only proves the DOM wiring — dragstart on the tab,
 * dragover/drop on the target group — actually reaches `splitEditorTabTo`/`moveEditorTabToGroup`.
 */
async function dragEditorTabToZone(
    page: Page,
    tab: Locator,
    target: Locator,
    { xRatio, yRatio }: { xRatio: number; yRatio: number },
): Promise<void> {
    // The `id` attribute lives on the inner `role="tab"` button (see `work-tab.tsx`), but `draggable` and the
    // `dragstart` listener that populates `EDITOR_DRAG_TYPE` are on the outer `.work-tab` element; the drag must
    // start from that ancestor.
    const tabButtonId = await tab.getByRole('tab').getAttribute('id');
    const targetGroupId = await target.getAttribute('data-group-id');
    if (!tabButtonId || !targetGroupId)
        throw new Error('Editor split drag fixture is missing an id');
    await page.evaluate(
        ({ tabButtonId: sourceButtonId, targetGroupId: groupId, xRatio: x, yRatio: y }) => {
            const sourceButton = document.querySelector(`#${CSS.escape(sourceButtonId)}`);
            const source = sourceButton?.closest('.work-tab');
            const dropTarget = document.querySelector(
                `.editor-group[data-group-id="${CSS.escape(groupId)}"]`,
            );
            if (!source || !dropTarget) throw new Error('Editor split drag fixture not found');
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
        { tabButtonId, targetGroupId, xRatio, yRatio },
    );
}

test('Editor split-right via the tab context menu converges on close and restores across restart', async () => {
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

        const editorGroups = running.page.locator('.editor-group');
        await expect(editorGroups).toHaveCount(1);

        await aTab.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Split Right' }).click();

        await expect(editorGroups).toHaveCount(2);
        await expect(running.page.locator('.editor-split.editor-split-horizontal')).toHaveCount(1);
        await expect(
            running.page.getByRole('separator', { name: 'Resize horizontal Editor split' }),
        ).toHaveCount(1);

        const splitRoot = await sessionEditorLayoutRoot(running.page);
        expect(splitRoot?.type).toBe('split');
        if (splitRoot?.type !== 'split') throw new Error('Editor layout did not split');
        expect(splitRoot.direction).toBe('horizontal');
        expect(
            splitRoot.first.type === 'group' &&
                splitRoot.first.paths.toSorted((left, right) => left.localeCompare(right)),
        ).toEqual([aPath, bPath].toSorted((left, right) => left.localeCompare(right)));
        expect(splitRoot.second.type === 'group' && splitRoot.second.paths).toEqual([aPath]);

        // Persistence across restart: the split-layout tree, not just the two open tabs, must survive relaunch.
        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect(running.page.locator('.editor-group')).toHaveCount(2);
        await expect(running.page.locator('.editor-split.editor-split-horizontal')).toHaveCount(1);
        const restoredRoot = await sessionEditorLayoutRoot(running.page);
        expect(restoredRoot?.type).toBe('split');
        if (restoredRoot?.type !== 'split') throw new Error('Editor layout did not restore');
        expect(restoredRoot.direction).toBe('horizontal');
        expect(restoredRoot.second.type === 'group' && restoredRoot.second.paths).toEqual([aPath]);
        await expect(
            running.page.locator('.work-tab:not([data-terminal-id])', { hasText: 'a.ts' }),
        ).toHaveCount(1);
        await expect(
            running.page.locator('.work-tab:not([data-terminal-id])', { hasText: 'b.ts' }),
        ).toHaveCount(1);

        // The new (right) pane holds only a.ts; closing its one tab removes a.ts everywhere (Editor tabs are global,
        // not per-pane) and the now-empty pane collapses out of the tree.
        const restoredATab = running.page.locator('.work-tab', { hasText: 'a.ts' });
        await restoredATab.hover();
        await restoredATab.locator('.tab-close').click();

        await expect(running.page.locator('.editor-group')).toHaveCount(1);
        await expect(running.page.locator('.editor-split')).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'a.ts' })).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'b.ts' })).toHaveCount(1);
        const convergedRoot = await sessionEditorLayoutRoot(running.page);
        expect(convergedRoot?.type).toBe('group');
        expect(convergedRoot?.type === 'group' && convergedRoot.paths).toEqual([bPath]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Editor split-down via a dragged tab converges back to a single pane on close', async () => {
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

        const editorGroups = running.page.locator('.editor-group');
        await expect(editorGroups).toHaveCount(1);
        const originalGroup = editorGroups.first();

        // Dropping near the bottom edge (within the 25% edge band from `resolveEditorDropZone`) resolves to the
        // "down" zone.
        await dragEditorTabToZone(running.page, bTab, originalGroup, { xRatio: 0.5, yRatio: 0.92 });

        await expect(editorGroups).toHaveCount(2);
        await expect(running.page.locator('.editor-split.editor-split-vertical')).toHaveCount(1);
        await expect(
            running.page.getByRole('separator', { name: 'Resize vertical Editor split' }),
        ).toHaveCount(1);

        const splitRoot = await sessionEditorLayoutRoot(running.page);
        expect(splitRoot?.type).toBe('split');
        if (splitRoot?.type !== 'split') throw new Error('Editor layout did not split');
        expect(splitRoot.direction).toBe('vertical');
        expect(
            splitRoot.first.type === 'group' &&
                splitRoot.first.paths.toSorted((left, right) => left.localeCompare(right)),
        ).toEqual([aPath, bPath].toSorted((left, right) => left.localeCompare(right)));
        expect(splitRoot.second.type === 'group' && splitRoot.second.paths).toEqual([bPath]);

        // The new (bottom) pane holds only b.ts; closing its tab removes b.ts everywhere and the empty pane
        // collapses, converging the tree back to a single pane.
        const newPaneTab = running.page.locator('.work-tab', { hasText: 'b.ts' });
        await newPaneTab.hover();
        await newPaneTab.locator('.tab-close').click();

        await expect(editorGroups).toHaveCount(1);
        await expect(running.page.locator('.editor-split')).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'b.ts' })).toHaveCount(0);
        await expect(running.page.locator('.work-tab', { hasText: 'a.ts' })).toHaveCount(1);
        const convergedRoot = await sessionEditorLayoutRoot(running.page);
        expect(convergedRoot?.type).toBe('group');
        expect(convergedRoot?.type === 'group' && convergedRoot.paths).toEqual([aPath]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
