import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import {
    chooseContextMenuItem,
    contextMenuLabels,
    dismissContextMenu,
    isContextMenuItemEnabled,
} from './support/native-context-menu.ts';

/**
 * Longer than the 500ms hover-to-activate timer the pane surface used to run, so a drag that still activated on hover
 * would have done it well before the assertion.
 */
const HELD_HOVER_MS = 900;

interface BootstrapSessionState {
    sessionId: string;
    paneLayout?: {
        activePaneId?: string;
        root?: { type: string };
    };
}

async function activePaneId(page: Page): Promise<string | undefined> {
    const bootstrap = await pageRequest<{ sessionStates: BootstrapSessionState[] }>(
        page,
        'app.bootstrap',
    );
    return bootstrap.sessionStates[0]?.paneLayout?.activePaneId;
}

async function terminalIdOf(page: Page): Promise<string> {
    const bootstrap = await pageRequest<{ terminals: Array<{ id: string }> }>(
        page,
        'app.bootstrap',
    );
    const id = bootstrap.terminals[0]?.id;
    if (!id) throw new Error('The Session was created without a Terminal');
    return id;
}

async function openAndPinFile(page: Page, name: string): Promise<Locator> {
    await page.getByRole('treeitem', { name, exact: true }).click();
    const tab = page.locator('.work-tab', { hasText: name });
    await tab.getByRole('tab').dblclick();
    await expect(tab).not.toHaveAttribute('data-preview');
    return tab;
}

/**
 * Starts a tab drag over another pane's surface and leaves it hanging there. The `DataTransfer` is parked on `window`
 * because a `drop` dispatched from a second `evaluate` call has to carry the same one the `dragstart` populated —
 * without it the drop reads no tab id and silently does nothing, which would make a hover-activation regression look
 * like a passing test.
 */
async function beginTabDragOverPane(page: Page, tab: Locator, targetPaneId: string): Promise<void> {
    const tabButtonId = await tab.getByRole('tab').getAttribute('id');
    if (!tabButtonId) throw new Error('Pane drag fixture is missing a tab id');
    await page.evaluate(
        ({ paneId, sourceButtonId }) => {
            const source = document
                .querySelector(`#${CSS.escape(sourceButtonId)}`)
                ?.closest('.work-tab');
            const dropTarget = document.querySelector(
                `.workbench-pane[data-pane-id="${CSS.escape(paneId)}"] .pane-surface`,
            );
            if (!source || !dropTarget) throw new Error('Pane drag fixture not found');
            const transfer = new DataTransfer();
            const bounds = dropTarget.getBoundingClientRect();
            const options = {
                // This fixture tests pane placement; Editor-to-Terminal drops require Option for that action.
                altKey: true,
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + bounds.width * 0.5,
                clientY: bounds.top + bounds.height * 0.5,
                dataTransfer: transfer,
            };
            Reflect.set(globalThis, '__caxriPaneDrag', { dropTarget, options, source });
            source.dispatchEvent(new DragEvent('dragstart', options));
            dropTarget.dispatchEvent(new DragEvent('dragenter', options));
            dropTarget.dispatchEvent(new DragEvent('dragover', options));
        },
        { paneId: targetPaneId, sourceButtonId: tabButtonId },
    );
}

async function finishTabDrag(page: Page): Promise<void> {
    await page.evaluate(() => {
        const drag = Reflect.get(globalThis, '__caxriPaneDrag') as
            { dropTarget: Element; options: DragEventInit; source: Element } | undefined;
        if (!drag) throw new Error('No pane drag in flight');
        drag.dropTarget.dispatchEvent(new DragEvent('dragover', drag.options));
        drag.dropTarget.dispatchEvent(new DragEvent('drop', drag.options));
        drag.source.dispatchEvent(new DragEvent('dragend', drag.options));
        Reflect.deleteProperty(globalThis, '__caxriPaneDrag');
    });
}

/**
 * Cancels a tab drag the way `Escape` does: the press and the focus it moved are real, the drag ends without ever
 * producing a `click`. Playwright cannot start a native HTML5 drag from synthetic mouse input, so the press is real and
 * only the drag events are dispatched.
 */
async function cancelTabDragFrom(page: Page, tab: Locator): Promise<void> {
    /**
     * Hovering rather than pressing a measured box is what keeps the press on the tab: `hover` runs Playwright's
     * actionability checks, including waiting for the layout box to stop moving, while a box read once and pressed a
     * few calls later can already be stale — tabs share their bar's width, so one tab leaving re-lays out the rest.
     */
    await tab.hover();
    await page.mouse.down();
    const tabButtonId = await tab.getByRole('tab').getAttribute('id');
    if (!tabButtonId) throw new Error('Drag-cancel fixture is missing a tab id');
    await page.evaluate((sourceButtonId) => {
        const source = document
            .querySelector(`#${CSS.escape(sourceButtonId)}`)
            ?.closest('.work-tab');
        if (!source) throw new Error('Drag-cancel fixture not found');
        const options = { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() };
        source.dispatchEvent(new DragEvent('dragstart', options));
        source.dispatchEvent(new DragEvent('dragend', options));
    }, tabButtonId);
}

/**
 * A pane holding a Terminal next to a document is the case the unified pane tree exists for, and the one nothing
 * exercised end to end: every other layout workflow keeps to a single kind, so a menu, a drop target, or a focus path
 * that quietly branches on `resource.kind` stays green in all of them.
 */
test('a pane holding a Terminal and a document treats both tabs the same', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-pane-mixed-kind-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    await writeFile(join(root, 'notes.ts'), 'export const notes = 1;\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const terminalId = await terminalIdOf(running.page);
        const terminalTab = running.page.locator(`.work-tab[data-terminal-id="${terminalId}"]`);
        const panes = running.page.locator('.workbench-pane');
        await expect(panes).toHaveCount(1);
        await expect(running.page.locator('.work-tab')).toHaveCount(1);

        /**
         * Close and Split are layout operations, so a Terminal tab has to offer the same ones a document tab does;
         * before this pass it offered only "Move to New Session", which is the one entry that really is the Terminal's
         * own. And a pane holding a single tab cannot split it off itself — the reducer no-ops — so the menu says why
         * instead of offering four items that do nothing.
         */
        await terminalTab.click({ button: 'right' });
        expect(await contextMenuLabels(running.app)).toEqual(
            expect.arrayContaining(['Move to New Session', 'Close to the Right']),
        );
        expect(await isContextMenuItemEnabled(running.app, 'Split Right')).toBe(false);
        await dismissContextMenu(running.app);

        const fileTab = await openAndPinFile(running.page, 'notes.ts');
        await expect(running.page.locator('.work-tab')).toHaveCount(2);
        await expect(panes).toHaveCount(1);

        /**
         * The same Terminal tab, now that its pane has somewhere to split from. A Terminal's bulk close spans the whole
         * rail rather than only the Terminals on it, so the document beside it is what these two entries act on;
         * scoping them to Terminals left both permanently disabled in exactly this layout.
         */
        await terminalTab.click({ button: 'right' });
        expect(await isContextMenuItemEnabled(running.app, 'Close Others')).toBe(true);
        expect(await isContextMenuItemEnabled(running.app, 'Close Editors')).toBe(true);
        await chooseContextMenuItem(running.app, 'Split Right');
        await expect(panes).toHaveCount(2);

        const paneIds = await panes.evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLElement).dataset.paneId),
        );
        const [documentPaneId, terminalPaneId] = paneIds;
        expect(documentPaneId).toBeTruthy();
        expect(terminalPaneId).toBeTruthy();
        await expect.poll(() => activePaneId(running.page)).toBe(terminalPaneId);

        await running.page.evaluate(() => {
            const controls = (
                globalThis as unknown as {
                    caxriE2E: { resetSessionStateUpdateCount: () => void };
                }
            ).caxriE2E;
            controls.resetSessionStateUpdateCount();
        });
        await fileTab.getByRole('tab').click();
        await running.page.evaluate(
            () =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }),
        );
        const clickPersistenceCount = await running.page.evaluate(() =>
            (
                globalThis as unknown as {
                    caxriE2E: { sessionStateUpdateCount: () => number };
                }
            ).caxriE2E.sessionStateUpdateCount(),
        );
        /**
         * One inactive-pane tab click selects the tab and its pane through one state transition. The pane's focus
         * capture must not persist the same SessionState first and leave tab selection to persist it a second time.
         */
        expect(clickPersistenceCount).toBe(1);
        await expect.poll(() => activePaneId(running.page)).toBe(documentPaneId);
        await terminalTab.getByRole('tab').click();
        await expect.poll(() => activePaneId(running.page)).toBe(terminalPaneId);
        /**
         * PaneBox keeps the pointer-click path marked through the next animation frame so its following focus event
         * does not persist the same selection twice. Let that click lifecycle retire before exercising programmatic
         * focus; otherwise a fast runner can incorrectly classify this independent focus as part of the preceding
         * click.
         */
        await running.page.evaluate(
            () =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => resolve());
                }),
        );

        /**
         * Every pane's active tab is `tabIndex=0`, so plain `Tab` traversal can put focus in a pane the user has not
         * clicked. That is a real pane change: leaving `activePaneId` behind would point the focus ring, the Status
         * Bar, and every layout-resolved command at the pane they just left. `focus()` is the same programmatic path
         * traversal and a cancelled drag take — no click follows it to finish the job.
         */
        await fileTab.getByRole('tab').focus();
        await expect.poll(() => activePaneId(running.page)).toBe(documentPaneId);

        /**
         * Option-dragging an Editor across panes previews where it would land; it must not activate the pane it merely
         * passes over. A held hover that changed the active pane would reorder Terminals under the user mid-drag, which
         * is why VS Code shows an insertion line and nothing else.
         */
        await beginTabDragOverPane(running.page, fileTab, terminalPaneId!);
        await running.page.waitForTimeout(HELD_HOVER_MS);
        await expect(running.page.locator('.pane-drop-preview')).toBeVisible();
        expect(await activePaneId(running.page)).toBe(documentPaneId);
        await expect(
            running.page.locator(`.workbench-pane[data-pane-id="${documentPaneId}"] .work-tab`),
        ).toHaveCount(1);

        await finishTabDrag(running.page);
        // The document pane held only this tab, so the drop collapses it and leaves one pane holding both kinds again.
        await expect(panes).toHaveCount(1);
        await expect(running.page.locator('.work-tab')).toHaveCount(2);
        /**
         * The drag just did both of the things a single tab bar cannot repair on its own: it moved the focused tab into
         * another pane — so `activePaneId` is no longer the bar that lost it — and it collapsed the source pane, which
         * unmounts that bar outright. Focus must still land on the tab that survived, not on `document.body`.
         *
         * Waiting for the count first is what makes this a real check: until the exit animation ends, the leaving copy
         * is still in the DOM and still matches `fileTab`, so asserting focus straight away can pass by catching the
         * outgoing ghost rather than the tab that arrived.
         */
        await expect(fileTab).toHaveCount(1);
        await expect(fileTab.getByRole('tab')).toBeFocused();

        /**
         * Closing the focused tab deletes the element holding keyboard focus, and the browser's fallback is
         * `document.body` — from which no arrow key or tablist shortcut works. The document left behind does not grab
         * focus the way a Terminal does, which is exactly why this direction is the one that stranded the user.
         *
         * Arrow-key navigation is what puts focus on the Terminal's own tab button and keeps it there; activating that
         * tab by mouse would hand focus straight to xterm instead.
         */
        await fileTab.getByRole('tab').click();
        await running.page.keyboard.press('ArrowLeft');
        const terminalTabButton = terminalTab.getByRole('tab');
        await expect(terminalTabButton).toBeFocused();
        // Selecting it also proves the Terminal survived being split out and dragged back, rather than being left as a
        // placeholder tab over a dead PTY.
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${terminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await running.page.keyboard.press('Meta+W');
        await expect(running.page.locator('.work-tab')).toHaveCount(1);
        await expect(fileTab.getByRole('tab')).toBeFocused();

        await running.page.reload();
        await expect(panes).toHaveCount(1);
        await expect(running.page.locator('.work-tab', { hasText: 'notes.ts' })).toHaveCount(1);
        await expect(
            running.page.locator(`.work-tab[data-terminal-id="${terminalId}"]`),
        ).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * The two interactions that reach a tab without ever producing the `click` the rest of the tab bar is built around: a
 * drag the user cancels, and the tab's own context menu. Both leave the Workbench in a state no single event can
 * describe — a press with no selection behind it, and a portal that holds focus while its action destroys the element
 * it would hand focus back to — so both are only observable end to end.
 */
test('a cancelled drag and a context-menu close both leave focus and the active pane agreeing', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-pane-focus-settle-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    await writeFile(join(root, 'notes.ts'), 'export const notes = 1;\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const terminalId = await terminalIdOf(running.page);
        const terminalTab = running.page.locator(`.work-tab[data-terminal-id="${terminalId}"]`);
        const fileTab = await openAndPinFile(running.page, 'notes.ts');
        const panes = running.page.locator('.workbench-pane');

        await terminalTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Split Right');
        await expect(panes).toHaveCount(2);
        /**
         * The split leaves an `inert` copy of the Terminal tab behind in the old bar for the length of its exit
         * animation, and that copy still takes up a share of the bar's width. Everything below either presses a tab by
         * position or addresses the Terminal tab by selector, so both need the bar to have finished settling first.
         */
        await expect(terminalTab).toHaveCount(1);
        const paneIds = await panes.evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLElement).dataset.paneId),
        );
        const [documentPaneId, terminalPaneId] = paneIds;
        await expect.poll(() => activePaneId(running.page)).toBe(terminalPaneId);

        /**
         * Pressing a tab in an inactive pane deliberately leaves the pane activation to the `click` that normally
         * follows, so one click costs one persist instead of two. A drag cancelled with `Escape` is the case where that
         * click never comes: `pointerdown → focusin → dragstart → dragend`. Focus is now in the document pane, so
         * `activePaneId` has to follow it — otherwise the focus ring, the Status Bar, and every layout-resolved command
         * keep pointing at the Terminal pane the user left.
         *
         * Asserted before releasing the button, because a real cancelled drag never produces a `pointerup` either.
         */
        await cancelTabDragFrom(running.page, fileTab);
        await expect.poll(() => activePaneId(running.page)).toBe(documentPaneId);
        await running.page.mouse.up();

        /**
         * The menu's own action destroys the tab the right click landed on. Closing through it must still leave focus
         * on the surviving tab rather than on `document.body`, where no arrow key or tablist shortcut reaches. Nothing
         * calls `focus()` afterwards here — that would hide the very result under test.
         */
        await terminalTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Close');
        await expect(panes).toHaveCount(1);
        await expect(running.page.locator('.work-tab')).toHaveCount(1);
        await expect(fileTab.getByRole('tab')).toBeFocused();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * Regression for #815: `PaneMountPortal` moves a pane's stable content into whichever DOM slot the split tree currently
 * gives it, and every earlier test here only exercises that move as a runtime split — one pane's portal already homed,
 * a sibling's freshly appended beside it. A reload instead builds a brand-new Renderer tree from an already-split
 * persisted layout, so both panes' portals mount for the first time in the same commit as `PaneView` itself: the
 * original "parent ready later than child" scenario the portal's slot-relocation effect has to handle without one
 * pane's content racing the other's onto screen. Nothing here waits or retries for that race — a plain visibility
 * assertion is what would flake if the effect still ran on the wrong signal.
 */
test('a Session with a mixed-kind split layout renders every pane on a fresh mount', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-pane-mixed-kind-reload-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    await writeFile(join(root, 'notes.ts'), 'export const notes = 1;\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const terminalId = await terminalIdOf(running.page);
        const terminalTab = running.page.locator(`.work-tab[data-terminal-id="${terminalId}"]`);
        const panes = running.page.locator('.workbench-pane');
        await openAndPinFile(running.page, 'notes.ts');
        await terminalTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Split Right');
        await expect(panes).toHaveCount(2);

        await running.page.reload();
        await expect(panes).toHaveCount(2);
        const paneIds = await panes.evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLElement).dataset.paneId),
        );
        const [documentPaneId, terminalPaneId] = paneIds;
        expect(documentPaneId).toBeTruthy();
        expect(terminalPaneId).toBeTruthy();

        const documentPane = running.page.locator(
            `.workbench-pane[data-pane-id="${documentPaneId}"]`,
        );
        const terminalPane = running.page.locator(
            `.workbench-pane[data-pane-id="${terminalPaneId}"]`,
        );
        await expect(documentPane.locator('.monaco-editor .view-lines')).toContainText(
            'export const notes',
        );
        await expect(
            terminalPane.locator(
                `.terminal-pane[data-terminal-id="${terminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
