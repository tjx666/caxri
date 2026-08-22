import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

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
        await expect(
            running.page.getByRole('menuitem', { name: 'Move to New Session' }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('menuitem', { name: 'Close to the Right' }),
        ).toBeVisible();
        await expect(running.page.getByRole('menuitem', { name: 'Split Right' })).toBeDisabled();
        await running.page.keyboard.press('Escape');

        const fileTab = await openAndPinFile(running.page, 'notes.ts');
        await expect(running.page.locator('.work-tab')).toHaveCount(2);
        await expect(panes).toHaveCount(1);

        // The same Terminal tab, now that its pane has somewhere to split from.
        await terminalTab.click({ button: 'right' });
        await expect(running.page.getByRole('menuitem', { name: 'Close Others' })).toBeEnabled();
        await running.page.getByRole('menuitem', { name: 'Split Right' }).click();
        await expect(panes).toHaveCount(2);

        const paneIds = await panes.evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLElement).dataset.paneId),
        );
        const [documentPaneId, terminalPaneId] = paneIds;
        expect(documentPaneId).toBeTruthy();
        expect(terminalPaneId).toBeTruthy();
        await expect.poll(() => activePaneId(running.page)).toBe(terminalPaneId);

        /**
         * Dragging a tab across panes previews where it would land; it must not activate the pane it merely passes
         * over. A held hover that changed the active pane would reorder Terminals under the user mid-drag, which is why
         * VS Code shows an insertion line and nothing else.
         */
        await beginTabDragOverPane(running.page, fileTab, terminalPaneId!);
        await running.page.waitForTimeout(HELD_HOVER_MS);
        await expect(running.page.locator('.pane-drop-preview')).toBeVisible();
        expect(await activePaneId(running.page)).toBe(terminalPaneId);
        await expect(
            running.page.locator(`.workbench-pane[data-pane-id="${documentPaneId}"] .work-tab`),
        ).toHaveCount(1);

        await finishTabDrag(running.page);
        // The document pane held only this tab, so the drop collapses it and leaves one pane holding both kinds again.
        await expect(panes).toHaveCount(1);
        await expect(running.page.locator('.work-tab')).toHaveCount(2);

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
