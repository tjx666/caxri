import type { Page } from '@playwright/test';
import { errors, expect } from '@playwright/test';

import type { E2EApp } from './electron-app.ts';
import { dismissContextMenu, isContextMenuItemEnabled } from './native-context-menu.ts';

export async function terminalTextBounds(page: Page, text: string) {
    return page.locator('.xterm-rows').evaluate((rows, target) => {
        /**
         * Finds the text-node offsets spanning `[targetStart, targetStart + target.length)` within `row`.
         */
        function findTextNodeRange(
            row: Element,
            targetStart: number,
        ):
            | { start: { node: Node; offset: number }; end: { node: Node; offset: number } }
            | undefined {
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let offset = 0;
            let start: { node: Node; offset: number } | undefined;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const length = node.textContent?.length ?? 0;
                if (!start && targetStart >= offset && targetStart <= offset + length)
                    start = { node, offset: targetStart - offset };
                const targetEnd = targetStart + target.length;
                if (targetEnd >= offset && targetEnd <= offset + length) {
                    return start ? { start, end: { node, offset: targetEnd - offset } } : undefined;
                }
                offset += length;
            }
            return undefined;
        }

        let matched: { x: number; y: number; width: number; height: number } | undefined;
        for (const row of rows.children) {
            const rowText = row.textContent;
            /**
             * Xterm renders cell spaces as non-breaking spaces; normalization preserves one code unit per cell.
             */
            const targetStart = rowText.replaceAll('\u{A0}', ' ').indexOf(target);
            if (targetStart === -1) continue;
            const found = findTextNodeRange(row, targetStart);
            if (!found) continue;
            const range = document.createRange();
            range.setStart(found.start.node, found.start.offset);
            range.setEnd(found.end.node, found.end.offset);
            const bounds = range.getBoundingClientRect();
            const candidate = {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            };
            /**
             * Xterm can recycle screen rows in a DOM order that differs from their visual order. Prefer the bottom-most
             * visible occurrence so echoed commands do not win over their later output.
             */
            if (!matched || candidate.y > matched.y) matched = candidate;
        }
        return matched ?? null;
    }, text);
}

/**
 * Moves off the target row before waiting for xterm's asynchronous link provider. xterm caches an empty provider result
 * when output replaces a blank row beneath a stationary pointer.
 *
 * Pass `expectHint` when the target is a real link: the approach is then retried until the hint appears, because a
 * single synthetic pointer move is not reliably enough for xterm to resolve one. A person drags the pointer across many
 * intermediate positions, so xterm gets many chances to ask its providers and to recompute the cell under the pointer
 * from a settled layout; `mouse.move` delivers exactly one event, and when that one event is the one xterm misreads,
 * nothing ever asks again — the pointer never moves, so the row stays cached as having no link.
 */
export async function hoverTerminalLink(
    page: Page,
    text: string,
    options: { expectHint?: boolean; expectPointerClass?: boolean } = {},
) {
    await expect.poll(() => terminalTextBounds(page, text)).not.toBeNull();
    const bounds = await terminalTextBounds(page, text);
    if (!bounds) throw new Error(`Terminal text not found: ${text}`);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    const rows = page.locator('.xterm-rows > div');
    const [firstRow, lastRow] = await Promise.all([
        rows.first().boundingBox(),
        rows.last().boundingBox(),
    ]);
    if (!firstRow || !lastRow) throw new Error('Terminal rows not found');
    const firstY = firstRow.y + firstRow.height / 2;
    const lastY = lastRow.y + lastRow.height / 2;
    const resetRow = Math.abs(y - firstY) > Math.abs(y - lastY) ? firstRow : lastRow;
    const hint = page.locator('.terminal-link-hint');
    const approach = async () => {
        await page.mouse.move(resetRow.x + 2, resetRow.y + resetRow.height / 2);
        await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(0);
        await expect(hint).toHaveCount(0);
        await page.mouse.move(x, y, { steps: 8 });
    };
    if (options.expectHint) {
        await expect
            .poll(
                async () => {
                    await approach();
                    try {
                        await hint.waitFor({ state: 'visible', timeout: 2000 });
                        return true;
                    } catch {
                        return false;
                    }
                },
                { intervals: [100], timeout: 20_000 },
            )
            .toBe(true);
    } else {
        await approach();
    }
    if (options.expectPointerClass)
        await expect(page.locator('.xterm-cursor-pointer')).toBeVisible();
    else await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(0);
    return bounds;
}

/**
 * How long one Cmd press may go without producing the pointer cursor before the helper presses again. Caxri applies an
 * observed modifier synchronously, so a press that is going to work shows the cursor within a frame or two.
 */
const MODIFIER_REARM_MS = 1000;

/**
 * Opens a link the way a person does: hover until the hint proves xterm resolved the link, hold Cmd until the pointer
 * cursor proves Caxri observed the modifier, then click.
 *
 * Caxri arms its modifier tracking from xterm's hover callback, so a `Meta` press that lands before xterm has a link
 * under the pointer has nothing to arm. Once armed, the modifier is tracked from document `keydown`/`keyup`, and a
 * window `blur` deliberately drops it because the matching `keyup` will never arrive. Under a parallel run another
 * worker's Electron window can take focus between `keyboard.down('Meta')` and the cursor check; after that nothing
 * re-arms the modifier and the pointer cursor never appears (github.com/tjx666/caxri/issues/697). A person notices and
 * presses Cmd again, and so does this helper: a press that has not produced the cursor within one re-arm interval is
 * released, the hover is re-confirmed, and Cmd is pressed again, inside the same overall budget a plain assertion had.
 * The click itself still requires the pointer cursor, so a modifier Caxri never observed remains a failure.
 */
export async function clickTerminalLink(page: Page, text: string): Promise<void> {
    let bounds = await hoverTerminalLink(page, text, { expectHint: true });
    const pointer = page.locator('.xterm-cursor-pointer');
    await page.keyboard.down('Meta');
    try {
        await expect
            .poll(
                async () => {
                    try {
                        await pointer.waitFor({ state: 'visible', timeout: MODIFIER_REARM_MS });
                        return true;
                    } catch (error) {
                        // Only "not visible yet" is a re-arm cue; a closed page or a strict-mode violation
                        // must surface as the first causal failure instead of burning the budget.
                        if (!(error instanceof errors.TimeoutError)) throw error;
                        await page.keyboard.up('Meta');
                        bounds = await hoverTerminalLink(page, text, { expectHint: true });
                        await page.keyboard.down('Meta');
                        return false;
                    }
                },
                {
                    intervals: [100],
                    message: `Cmd never produced the pointer cursor over "${text}" after re-arming`,
                    timeout: 15_000,
                },
            )
            .toBe(true);
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    } finally {
        await page.keyboard.up('Meta');
    }
}

/**
 * With nothing selected, the Terminal menu still offers Copy but disables it. A native menu cannot carry the disabled
 * reason as a tooltip, so only the disabled state is observable.
 */
export async function expectDisabledTerminalCopy(app: E2EApp, page: Page): Promise<void> {
    /**
     * The screen overlays DOM rows; click the empty row's coordinates, as link probes do, without selecting the prompt.
     */
    const bounds = await page.locator('.xterm-rows > div').last().boundingBox();
    if (!bounds) throw new Error('The empty Terminal row is not visible');
    await page.mouse.click(bounds.x + 4, bounds.y + bounds.height / 2, { button: 'right' });
    expect(await isContextMenuItemEnabled(app, 'Copy')).toBe(false);
    await dismissContextMenu(app);
}
