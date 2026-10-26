import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import type { Page } from 'playwright';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { publishFullScreenState } from './support/full-screen-state.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pressNewTerminal,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './support/helpers.ts';

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
    // Counted from what is already open so a test can widen an existing set in a second call.
    const alreadyOpen = await documentTabs.count();
    for (const [index, name] of fileNames.entries()) {
        // eslint-disable-next-line no-await-in-loop -- each open is causally ordered by the rendered tab receipt
        await page.getByRole('treeitem', { name, exact: true }).dblclick();
        // eslint-disable-next-line no-await-in-loop -- the next double-click must not race the current tab creation
        await expect(documentTabs).toHaveCount(alreadyOpen + index + 1);
    }
}

test('Terminal tabs anchor at the leading edge, Document tabs size to content and scroll past them', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-mixed-width-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    const firstFileNames = ['a-short.ts', 'b-much-longer-document-name.ts'];
    // Enough long filenames that the document segment alone overflows a narrowed window.
    const fileNames = [
        ...firstFileNames,
        'c-much-longer-document-name.ts',
        'd-much-longer-document-name.ts',
        'e-much-longer-document-name.ts',
        'f-much-longer-document-name.ts',
        'g-much-longer-document-name.ts',
        'h-much-longer-document-name.ts',
    ];
    for (const name of fileNames) {
        // eslint-disable-next-line no-await-in-loop -- sequential fixture writes, order does not matter but simplicity does
        await writeFile(join(root, name), '', 'utf8');
    }

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const strip = running.page.locator('.work-tabs');
        const scrollRail = running.page.locator('.work-tab-scroll');
        const anchoredSegment = running.page.locator('.work-tab-sticky');
        const terminalTabs = strip.locator('.work-tab[data-terminal-id]');
        const documentTabs = strip.locator('.work-tab:not([data-terminal-id])');

        // Both containers exist from the start; with no documents to make room for, the anchored one takes the whole
        // bar and its Terminals still divide it evenly.
        await expect(anchoredSegment).toHaveCount(1);
        expect(
            await anchoredSegment.evaluate((element) => {
                const widths = [...element.querySelectorAll('.work-tab')].map(
                    (tab) => tab.getBoundingClientRect().width,
                );
                return Math.round(Math.max(...widths) - Math.min(...widths));
            }),
        ).toBeLessThanOrEqual(1);

        /**
         * A tab must never change container: one that animated out of the rail while already mounted anchored would
         * exist twice for the length of that animation, which no settled assertion can see. Opening the first document
         * is where a kind-blind bar would make that move, so watch the DOM through it rather than after it.
         */
        await running.page.evaluate(() => {
            const seen: number[] = [];
            const record = () => {
                const ids = [...document.querySelectorAll('.work-tabs .work-tab')].map(
                    (tab) => (tab as HTMLElement).dataset.paneTabId ?? '',
                );
                seen.push(ids.length - new Set(ids).size);
            };
            record();
            const observer = new MutationObserver(record);
            observer.observe(document.body, { childList: true, subtree: true });
            Object.assign(globalThis, { __paneTabDuplicates: seen });
        });

        await openDocumentTabs(running.page, firstFileNames);
        await expect(documentTabs).toHaveCount(2);
        await waitForTabMotionToSettle(running.page);
        await expect(anchoredSegment).toHaveCount(1);
        expect(
            await running.page.evaluate(() =>
                Math.max(
                    ...((globalThis as { __paneTabDuplicates?: number[] }).__paneTabDuplicates ?? [
                        0,
                    ]),
                ),
            ),
        ).toBe(0);

        // A document uses its full filename, and the Terminal beside it keeps its own title readable.
        const documentWidths = await documentTabs.evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().width),
        );
        for (const width of documentWidths) {
            expect(width).toBeGreaterThanOrEqual(50);
        }
        expect(documentWidths[1]).toBeGreaterThan(160);
        expect(
            await documentTabs
                .nth(1)
                .locator('.tab-label')
                .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(
            await terminalTabs
                .first()
                .locator('.tab-label')
                .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(
            await scrollRail.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeLessThanOrEqual(1);

        /**
         * The reason the segment exists: reading a handful of files must not cost the Session's Agent Terminal its
         * place on the bar. Narrow the window and open the rest so the documents genuinely overflow.
         */
        await running.page.setViewportSize({ width: 900, height: 700 });
        await openDocumentTabs(running.page, fileNames.slice(firstFileNames.length));
        await expect(documentTabs).toHaveCount(fileNames.length);
        await waitForTabMotionToSettle(running.page);

        expect(
            await scrollRail.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeGreaterThan(1);

        /**
         * The document just opened is the active one, and it must already be readable without the user scrolling the
         * rail. Measured against the rail rather than the viewport because the rail is what clips it. Polled because a
         * tab enters from `maxWidth: 0` and the reveal keeps re-running while that animation widens it
         * (`useActiveTabReveal` in `apps/desktop/src/renderer/src/features/workbench/pane-tab-reveal.ts`), a one-shot
         * reveal measured at creation time computes a near-zero delta and leaves the tab off the end of the bar.
         *
         * "Readable" is the leading edge, not the whole box. At this window width one of these filenames is wider than
         * the rail that holds it, and the reveal aligns such a tab to the rail's start rather than its end: the same
         * choice VS Code's `doLayoutTabsNonWrapping` makes, because scrolling to the tail of a name shows the reader
         * the extension and hides the part that tells the files apart.
         */
        await expect
            .poll(async () =>
                running.page.evaluate(() => {
                    const rail = document.querySelector<HTMLElement>('.work-tab-scroll');
                    const tab = rail?.querySelector<HTMLElement>('[data-tab-active="true"]');
                    if (!rail || !tab) return;
                    const railRect = rail.getBoundingClientRect();
                    const tabRect = tab.getBoundingClientRect();
                    if (tabRect.left < railRect.left - 1) return false;
                    return tabRect.right <= railRect.right + 1 || tabRect.left <= railRect.left + 1;
                }),
            )
            .toBe(true);

        const anchoredLeftBeforeScroll = await terminalTabs
            .first()
            .evaluate((element) => element.getBoundingClientRect().left);
        await scrollRail.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
        });
        await expect
            .poll(async () => scrollRail.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(1);
        expect(
            await terminalTabs.first().evaluate((element) => element.getBoundingClientRect().left),
        ).toBeCloseTo(anchoredLeftBeforeScroll, 0);
        await expect(terminalTabs.first()).toBeInViewport();
        // The "+" action stays reachable outside the scrolling rail no matter how far it has scrolled.
        await expect(running.page.getByRole('button', { name: 'New Terminal' })).toBeVisible();

        /**
         * The anchor is capped rather than unbounded: many Terminals scroll inside their own segment instead of
         * squeezing the documents out in the other direction.
         *
         * `cmd+t` rather than the "+" button: with no default Agent configured the button's primary half opens its
         * agent menu instead of creating straight away (`NewTerminalButton`), and this spec is about the rail, not
         * about which Agent starts.
         */
        for (let index = 0; index < 8; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- each new tab depends on the previous one's enter animation settling
            await pressNewTerminal(running.page);
        }
        await expect(terminalTabs).toHaveCount(9);
        await waitForTabMotionToSettle(running.page);

        const segments = await running.page.evaluate(() => {
            const list = document.querySelector<HTMLElement>(
                '[data-pane-tab-bar] [role="tablist"]',
            );
            const anchored = document.querySelector<HTMLElement>('.work-tab-sticky');
            const rail = document.querySelector<HTMLElement>('.work-tab-scroll');
            if (!list || !anchored || !rail) throw new Error('Work tab segments not found');
            return {
                anchoredOverflow: anchored.scrollWidth - anchored.clientWidth,
                anchoredWidth: anchored.getBoundingClientRect().width,
                listWidth: list.getBoundingClientRect().width,
                railWidth: rail.getBoundingClientRect().width,
            };
        });
        expect(segments.anchoredWidth).toBeLessThanOrEqual(segments.listWidth / 2 + 1);
        expect(segments.anchoredOverflow).toBeGreaterThan(1);
        expect(segments.railWidth).toBeGreaterThan(0);
        // Each Terminal keeps its displayed title readable even when document names consume the rail.
        expect(
            await terminalTabs
                .locator('.tab-label')
                .evaluateAll((elements) =>
                    elements.every((element) => element.scrollWidth <= element.clientWidth),
                ),
        ).toBe(true);

        await terminalTabs.last().scrollIntoViewIfNeeded();
        await expect(terminalTabs.last()).toBeInViewport();
    } finally {
        await closeAppQuietly(running.app);
        await removeQuitTestDirectory(testDirectory);
    }
});

test('the tab bar reveals the Agent menu on hover with one tab and accents only the focused pane', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-sole-tab-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const rootInput = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', rootInput]);
    const root = await realpath(rootInput);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });

    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const tabs = running.page.locator('.work-tabs .work-tab');
        const newTerminal = running.page.getByRole('button', { name: /^New .*Terminal$/u });
        const newTerminalSlot = running.page.locator('.work-tabs .tab-actions > div');
        await expect(tabs).toHaveCount(1);
        await waitForTabMotionToSettle(running.page);

        /**
         * Nothing to switch between: the active accent stays absent, and the creation action floats over the tab's
         * trailing end without a slot of its own, revealed only when the user reaches the tab bar. A reserved slot
         * showed the bar's fill beside the full-width tab as a block.
         */
        const accentHeight = (element: Element) =>
            // eslint-disable-next-line unicorn/prefer-number-coercion -- the computed height carries a "px" suffix, which `Number()` cannot parse
            Number.parseFloat(getComputedStyle(element, '::before').height) || 0;
        expect(await tabs.first().evaluate(accentHeight)).toBe(0);
        await expect(newTerminal).toHaveCount(1);
        await expect(newTerminalSlot).toHaveCSS('opacity', '0');
        const reservedActionWidth = await running.page
            .locator('.work-tabs .tab-actions')
            .evaluate((element) => element.getBoundingClientRect().width);
        expect(reservedActionWidth).toBe(0);
        await tabs.first().hover();
        await expect(newTerminalSlot).toHaveCSS('opacity', '1');
        await newTerminal.hover();
        const agentMenu = running.page.getByRole('menu', { name: 'New Terminal' });
        await expect(agentMenu).toBeVisible();
        await running.page.keyboard.press('Meta+t');
        await expect(tabs).toHaveCount(1);
        await expect(agentMenu).toBeVisible();
        await agentMenu.getByRole('menuitem', { exact: true, name: 'Codex' }).hover();
        await expect(agentMenu).toBeVisible();
        await running.page.mouse.move(0, 300);
        await expect(agentMenu).toBeHidden();
        await newTerminal.hover();
        await expect(agentMenu).toBeVisible();
        // A lone pane still says which of how many it is, so the label stays parseable once a split arrives.
        await expect(
            running.page.getByRole('tablist', { name: 'Open tabs in pane 1 of 1', exact: true }),
        ).toBeVisible();

        // Choosing Codex creates another Terminal in this Session without replacing the original Shell.
        const existingTerminalIds = await running.page
            .locator('.work-tab[data-terminal-id]')
            .evaluateAll((elements) => elements.map((element) => element.dataset.terminalId ?? ''));
        await agentMenu.getByRole('menuitem', { exact: true, name: 'Codex' }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, existingTerminalIds);
        await expect(tabs).toHaveCount(2);
        await expect(running.page.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();
        await expect(
            running.page.locator(`.work-tab[data-terminal-id="${existingTerminalIds[0]}"]`),
        ).toBeVisible();
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
         * stricter: it marks the focused pane's active tab only, so exactly one of the two active tabs carries it
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
        // past the 500ms this delay used to be, a timer can fire late on a loaded machine but never early, so
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

test('the bar hides "+" with no tabs at all and reserves its drag corner only without either sidebar', async () => {
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
        await expect(actions).toHaveCount(1);
        await expect(actions.locator(':scope > div')).toHaveCSS('opacity', '0');

        // Neither sidebar may sit beside the bar: an open SecondarySidebar ends it at that rail, not the window corner.
        await running.page.keyboard.press('Meta+BracketLeft');
        await expect(running.page.locator('.primary-sidebar-title')).toHaveCount(0);
        await expect(dragCorner).toHaveCount(0);
        await running.page.keyboard.press('Meta+BracketRight');
        await expect(dragCorner).toHaveJSProperty('offsetWidth', 32);

        /**
         * A side-by-side split ends the leading bar in the middle of the window, where its neighbour's first tab
         * begins, not in the window corner. Reserving the strip there wedges dead space between "+" and that neighbour,
         * which is the opposite of what the corner exists for. The traffic-light inset on the same bar still gives the
         * window somewhere to be dragged from.
         */
        await running.page.keyboard.press('Meta+Backslash');
        await expect(running.page.locator('[data-pane-tab-bar]')).toHaveCount(2);
        await expect(dragCorner).toHaveCount(0);
        await running.page.keyboard.press('Meta+w');
        await expect(running.page.locator('[data-pane-tab-bar]')).toHaveCount(1);
        await expect(dragCorner).toHaveCount(1);

        await running.page.keyboard.press('Meta+BracketLeft');
        await expect(dragCorner).toHaveCount(0);

        const onlyTab = running.page.locator('.work-tabs .work-tab').first();
        // With one tab, the close button and active accent stay absent. Terminal > Close Terminal on that last tab
        // closes the Terminal and leaves the Session open and empty, the same meaning as `cmd+w`.
        await onlyTab.hover();
        await expect(onlyTab.getByRole('button', { name: 'Close Terminal' })).toHaveCount(0);
        await running.app.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()
                ?.getMenuItemById('command.terminal.close')
                ?.click({ triggeredByAccelerator: false });
        });
        await expect(running.page.locator('.work-tabs .work-tab')).toHaveCount(0);
        await expect(running.page.locator('aside .archived-sessions-entry')).toHaveText(/\D0$/);
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
