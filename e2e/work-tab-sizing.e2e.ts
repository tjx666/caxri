import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import type { Page } from 'playwright';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { publishFullScreenState } from './support/full-screen-state.ts';
import {
    createProjectSession,
    launchCaxri,
    pressNewTerminal,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './support/helpers.ts';

/**
 * Closes the Electron app during teardown without letting an already-closed app fail the test.
 */
async function closeAppQuietly(app: E2EApp): Promise<void> {
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

/**
 * Opening the next file before the previous double-click creates its tab can replace or lose an input under CI load.
 * Bind each fixture action to the observable tab count so the later drag assertions start from the intended documents.
 */
async function openDocumentTabs(page: Page, fileNames: readonly string[]): Promise<void> {
    const documentTabs = page.locator('.work-tabs .work-tab:not([data-terminal-id])');
    for (const [index, name] of fileNames.entries()) {
        // eslint-disable-next-line no-await-in-loop -- each open is causally ordered by the rendered tab receipt
        await page.getByRole('treeitem', { name, exact: true }).dblclick();
        // eslint-disable-next-line no-await-in-loop -- the next double-click must not race the current tab creation
        await expect(documentTabs).toHaveCount(index + 1);
    }
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

        await openDocumentTabs(running.page, fileNames);
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

        // Squeezed this far, every label is clipped — which is exactly when the tooltip has something to add and
        // must appear. (`primary-sidebar-chrome.e2e.ts` covers the other half: an unclipped label offers none.)
        const squeezedTab = terminalTabs.first().locator('.tab-select');
        const isLabelClipped = await squeezedTab
            .locator('.tab-label')
            .evaluate((element) => element.scrollWidth > element.clientWidth);
        expect(isLabelClipped).toBe(true);
        await squeezedTab.hover();
        // `[data-open]` because a previously shown tooltip stays mounted through its exit animation.
        await expect(running.page.locator('.tooltip-popup[data-open]')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await removeQuitTestDirectory(testDirectory);
    }
});

test('the tab bar hides the "+" button only at a single Workbench-wide tab and accents only the focused pane', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-sole-tab-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const tabs = running.page.locator('.work-tabs .work-tab');
        const newTerminal = running.page.getByRole('button', { name: 'New Terminal' });
        await expect(tabs).toHaveCount(1);
        await waitForTabMotionToSettle(running.page);

        /**
         * Nothing to switch between: neither affordance has anything to say, and the active pane's own accent ring
         * still marks focus. iTerm2 hides both at one tab for the same reason.
         */
        const accentHeight = (element: Element) =>
            // eslint-disable-next-line unicorn/prefer-number-coercion -- the computed height carries a "px" suffix, which `Number()` cannot parse
            Number.parseFloat(getComputedStyle(element, '::before').height) || 0;
        expect(await tabs.first().evaluate(accentHeight)).toBe(0);
        await expect(newTerminal).toHaveCount(0);
        // A lone pane still says which of how many it is, so the label stays parseable once a split arrives.
        await expect(
            running.page.getByRole('tablist', { name: 'Open tabs in pane 1 of 1', exact: true }),
        ).toBeVisible();

        // A second tab restores both. `cmd+t` rather than the button, which is exactly what is missing right now.
        const existingTerminalIds = await running.page
            .locator('.work-tab[data-terminal-id]')
            .evaluateAll((elements) => elements.map((element) => element.dataset.terminalId ?? ''));
        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, existingTerminalIds);
        await expect(tabs).toHaveCount(2);
        await waitForTabMotionToSettle(running.page);
        await expect(newTerminal).toBeVisible();
        const activeAccent = await running.page
            .locator('.work-tab[data-tab-active="true"]')
            .evaluate(accentHeight);
        expect(activeAccent).toBeGreaterThan(0);

        const activeTabButton = running.page.locator(
            '.work-tab[data-tab-active="true"] .tab-select',
        );
        await activeTabButton.focus();
        await expect(activeTabButton).toBeFocused();
        await activeTabButton.press('ArrowLeft');
        await expect(activeTabButton).toBeFocused();
        const focusPresentation = await activeTabButton.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
                color: style.outlineColor,
                expectedColor: getComputedStyle(document.documentElement).color,
                focusVisible: element.matches(':focus-visible'),
                offset: style.outlineOffset,
                style: style.outlineStyle,
                width: style.outlineWidth,
            };
        });
        expect(focusPresentation).toEqual({
            color: focusPresentation.expectedColor,
            expectedColor: focusPresentation.expectedColor,
            focusVisible: true,
            offset: '-2px',
            style: 'solid',
            width: '1px',
        });

        /**
         * Splitting leaves one tab in each pane. The "+" rule is Workbench-wide, not per-pane: a pane holding its only
         * tab still has a sibling pane to be distinguished from, so the button survives in both panes. The accent is
         * stricter — it marks the focused pane's active tab only, so exactly one of the two active tabs carries it
         * (`pane-tab-bar.tsx` gates `showActiveAccent` on `isActivePane`).
         */
        await splitTerminalToRight(running.page, secondTerminalId);
        await expect(running.page.locator('.work-tabs')).toHaveCount(2);
        await expect(tabs).toHaveCount(2);
        await waitForTabMotionToSettle(running.page);
        await expect(newTerminal).toHaveCount(2);
        const accentedActiveTabs = await running.page
            .locator('.work-tab[data-tab-active="true"]')
            .evaluateAll(
                (elements) =>
                    elements.filter(
                        (element) =>
                            // eslint-disable-next-line unicorn/prefer-number-coercion -- the computed height carries a "px" suffix, which `Number()` cannot parse
                            (Number.parseFloat(getComputedStyle(element, '::before').height) || 0) >
                            0,
                    ).length,
            );
        expect(accentedActiveTabs).toBe(1);
        for (const label of ['Open tabs in pane 1 of 2', 'Open tabs in pane 2 of 2']) {
            // eslint-disable-next-line no-await-in-loop -- two independent visibility assertions, sequencing is irrelevant
            await expect(
                running.page.getByRole('tablist', { exact: true, name: label }),
            ).toBeVisible();
        }
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
        await openDocumentTabs(running.page, fileNames);
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

test('dragging a work tab over a sibling shows an insertion line and previews the hovered tab', async () => {
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
        await openDocumentTabs(running.page, fileNames);
        const documentTabs = running.page.locator('.work-tabs .work-tab:not([data-terminal-id])');
        await expect(documentTabs).toHaveCount(3);
        await waitForTabMotionToSettle(running.page);

        // c.ts opened last, so it is the active tab; hovering a drag of it over a.ts is what draws the
        // insertion line and, once the drag lingers, what previews a.ts.
        const source = documentTabs.filter({ hasText: 'c.ts' });
        const target = documentTabs.filter({ hasText: 'a.ts' });
        await expect(source.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
        await expect(target.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
        const sourceButtonId = await source.getByRole('tab').getAttribute('id');
        const targetBounds = await target.evaluate((element) => element.getBoundingClientRect());
        if (!sourceButtonId) throw new Error('Work tab drag fixture is missing an id');
        const dropX = targetBounds.x + targetBounds.width * 0.25;
        const dropY = targetBounds.y + targetBounds.height / 2;

        await running.page.evaluate(
            ({ sourceButtonId: id, dropX, dropY }) => {
                const sourceButton = document.querySelector(`#${CSS.escape(id)}`);
                const source = sourceButton?.closest('.work-tab');
                const bar = document.querySelector('[data-pane-tab-bar]');
                if (!source || !bar) throw new Error('Work tab drag preview fixture not found');
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
                // Resolved via `elementFromPoint` (not a fixed `.work-tab` reference) so `event.target`
                // matches what a real cursor-driven drag reports. This also means the marker's own
                // `pointer-events-none` is load-bearing here: once it renders over this point, a later
                // `elementFromPoint` at the same spot must still resolve through it to the tab
                // underneath, not to the marker.
                document
                    .elementFromPoint(dropX, dropY)
                    ?.dispatchEvent(new DragEvent('dragover', options));
            },
            { sourceButtonId, dropX, dropY },
        );

        const marker = running.page.locator('.work-tab-drop-marker');
        await expect(marker).toBeVisible();
        const markerLeft = await marker.evaluate((element) => element.getBoundingClientRect().left);
        expect(Math.abs(markerLeft - targetBounds.x)).toBeLessThanOrEqual(2);

        // A second dragover at the same point, now that the marker overlays it, exercises exactly the
        // `pointer-events-none` requirement noted above.
        await running.page.evaluate(
            ({ dropX, dropY }) => {
                const transfer = new DataTransfer();
                document.elementFromPoint(dropX, dropY)?.dispatchEvent(
                    new DragEvent('dragover', {
                        bubbles: true,
                        cancelable: true,
                        clientX: dropX,
                        clientY: dropY,
                        dataTransfer: transfer,
                    }),
                );
            },
            { dropX, dropY },
        );

        // A cursor merely crossing a tab on its way to the drop position must not flip the content under it, so
        // short of the hover threshold the selection still belongs to the dragged tab. The wait deliberately sits
        // past the 500ms this delay used to be — a timer can fire late on a loaded machine but never early, so
        // this pins the threshold as VS Code's unhurried one rather than any value below it.
        await running.page.waitForTimeout(1_200);
        await expect(target.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
        await expect(source.getByRole('tab')).toHaveAttribute('aria-selected', 'true');

        // Lingering past it previews the hovered tab's content, matching VS Code's
        // `DRAG_OVER_OPEN_TAB_THRESHOLD` (`multiEditorTabsControl.ts`). The insertion line stays where it is:
        // the preview answers "what am I dropping next to", it does not move the drop position.
        await expect(target.getByRole('tab')).toHaveAttribute('aria-selected', 'true', {
            timeout: 5000,
        });
        await expect(source.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
        await expect(marker).toBeVisible();

        await running.page.evaluate(() => {
            document
                .querySelector('[data-pane-tab-bar]')
                ?.dispatchEvent(
                    new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }),
                );
        });
        await expect(marker).toBeHidden();

        // A drag abandoned over a tab (Escape, or a drop outside every bar) leaves `dragend` as the only signal, so
        // a pending preview timer that survived it would flip the content well after the drag itself was gone.
        // a.ts is the active tab now, so hovering it over c.ts is the direction that would be observable.
        const cancelSourceId = await target.getByRole('tab').getAttribute('id');
        const cancelBounds = await source.evaluate((element) => element.getBoundingClientRect());
        if (!cancelSourceId) throw new Error('Work tab drag fixture is missing an id');
        await running.page.evaluate(
            ({ cancelSourceId: id, hoverX, hoverY }) => {
                const tab = document.querySelector(`#${CSS.escape(id)}`)?.closest('.work-tab');
                const bar = document.querySelector('[data-pane-tab-bar]');
                if (!tab || !bar) throw new Error('Work tab drag cancel fixture not found');
                const options = {
                    bubbles: true,
                    cancelable: true,
                    clientX: hoverX,
                    clientY: hoverY,
                    dataTransfer: new DataTransfer(),
                };
                tab.dispatchEvent(new DragEvent('dragstart', options));
                bar.dispatchEvent(new DragEvent('dragenter', options));
                document
                    .elementFromPoint(hoverX, hoverY)
                    ?.dispatchEvent(new DragEvent('dragover', options));
                tab.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
            },
            {
                cancelSourceId,
                hoverX: cancelBounds.x + cancelBounds.width * 0.25,
                hoverY: cancelBounds.y + cancelBounds.height / 2,
            },
        );
        await running.page.waitForTimeout(2_000);
        await expect(source.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
        await expect(target.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('a drag hover preview activates a Terminal tab without pulling focus into it', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-hover-focus-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const tabs = running.page.locator('.work-tabs .work-tab[data-terminal-id]');
        await expect(tabs).toHaveCount(1);
        await pressNewTerminal(running.page);
        await expect(tabs).toHaveCount(2);
        await waitForTabMotionToSettle(running.page);

        // The newest Terminal is active and owns the keyboard, which is what makes the preview below observable:
        // activating the other Terminal the ordinary way would move focus into its xterm.
        const source = tabs.nth(1);
        const target = tabs.nth(0);
        await expect(target.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
        const sourceButtonId = await source.getByRole('tab').getAttribute('id');
        const targetBounds = await target.evaluate((element) => element.getBoundingClientRect());
        if (!sourceButtonId) throw new Error('Terminal tab drag fixture is missing an id');

        await running.page.evaluate(
            ({ sourceButtonId: id, hoverX, hoverY }) => {
                const tab = document.querySelector(`#${CSS.escape(id)}`)?.closest('.work-tab');
                const bar = document.querySelector('[data-pane-tab-bar]');
                if (!tab || !bar) throw new Error('Terminal tab drag preview fixture not found');
                const options = {
                    bubbles: true,
                    cancelable: true,
                    clientX: hoverX,
                    clientY: hoverY,
                    dataTransfer: new DataTransfer(),
                };
                tab.dispatchEvent(new DragEvent('dragstart', options));
                bar.dispatchEvent(new DragEvent('dragenter', options));
                document
                    .elementFromPoint(hoverX, hoverY)
                    ?.dispatchEvent(new DragEvent('dragover', options));
            },
            {
                hoverX: targetBounds.x + targetBounds.width * 0.25,
                hoverY: targetBounds.y + targetBounds.height / 2,
                sourceButtonId,
            },
        );

        await expect(target.getByRole('tab')).toHaveAttribute('aria-selected', 'true', {
            timeout: 5_000,
        });
        // VS Code previews a dragged-over editor with `preserveFocus: true`; a previewed Terminal that grabbed the
        // keyboard would send the rest of the drag's keystrokes (Escape to cancel, above all) into the PTY. The
        // poll rather than a single read is what covers the asynchronous PTY-running transition that focuses xterm.
        await expect
            .poll(
                async () =>
                    running.page.evaluate(() => Boolean(document.activeElement?.closest('.xterm'))),
                { timeout: 2_000 },
            )
            .toBe(false);
    } finally {
        await closeAppQuietly(running.app);
        await removeQuitTestDirectory(testDirectory);
    }
});

test('the bar hides "+" with no tabs at all and reserves its drag corner only without the primarySidebar', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-drag-corner-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const actions = running.page.locator('.work-tabs .tab-actions');
        const dragCorner = running.page.locator('.work-tabs-drag-handle');
        await expect(running.page.locator('.work-tabs .work-tab')).toHaveCount(1);
        await waitForTabMotionToSettle(running.page);

        // `primary-sidebar-title` is a drag region of its own, so while the sidebar is open the window already moves
        // from there and a second reserved strip would only wedge dead space beside the tabs.
        await expect(dragCorner).toHaveCount(0);
        await expect(actions).toHaveCount(0);

        // Hidden, the bar becomes the whole titlebar: evenly divided tabs would reach the window's right edge and
        // leave nothing to grab, so the corner appears exactly there.
        await running.page.keyboard.press('Meta+BracketLeft');
        await expect(running.page.locator('.primary-sidebar-title')).toHaveCount(0);
        await expect(dragCorner).toHaveCount(1);
        await expect(dragCorner).toHaveJSProperty('offsetWidth', 32);
        await running.page.keyboard.press('Meta+BracketLeft');
        await expect(dragCorner).toHaveCount(0);

        // Closing the last Terminal used to bring "+" back, because the rule keyed off "exactly one tab" and an empty
        // Workbench is not one tab. The empty pane offers its own New Terminal button, so the bar stays bare.
        const onlyTab = running.page.locator('.work-tabs .work-tab').first();
        // The close affordance only materializes on hover (`tab-close` is `opacity-0 pointer-events-none` until then).
        await onlyTab.hover();
        await onlyTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect(running.page.getByText('No Terminal in this Session.')).toBeVisible();
        await expect(running.page.locator('.work-tabs .work-tab')).toHaveCount(0);
        await expect(actions).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await removeQuitTestDirectory(testDirectory);
    }
});

test('the collapsed root tab bar only reserves traffic-light space outside fullscreen', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-fullscreen-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const rootBar = running.page.locator('.work-tabs').first();
        const collapsedTitlebar = running.page.locator('.collapsed-primary-sidebar-titlebar');
        await running.page.keyboard.press('Meta+BracketLeft');
        await expect(running.page.locator('.primary-sidebar-title')).toHaveCount(0);
        await expect(collapsedTitlebar).toHaveCount(1);

        await expect(rootBar).toHaveCSS('padding-left', '78px');

        await publishFullScreenState(running.app, true);
        await expect(collapsedTitlebar).toHaveCount(0);
        await expect(rootBar).toHaveCSS('padding-left', '0px');

        await publishFullScreenState(running.app, false);
        await expect(collapsedTitlebar).toHaveCount(1);
        await expect(rootBar).toHaveCSS('padding-left', '78px');
    } finally {
        await closeAppQuietly(running.app);
        await removeQuitTestDirectory(testDirectory);
    }
});
