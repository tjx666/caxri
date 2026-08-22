import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Reads a Locator's width only once two consecutive `requestAnimationFrame`-aligned reads agree, so a pixel baseline is
 * never pinned while a Motion transition (tab enter/exit, a `zoom-in-95` dialog, a sliding indicator) is still
 * playing.
 */
export async function stableWidth(locator: Locator): Promise<number> {
    let previous = NaN;
    await expect
        .poll(async () => {
            const width = await locator.evaluate(
                (element) =>
                    new Promise<number>((resolve) =>
                        requestAnimationFrame(() => resolve(element.getBoundingClientRect().width)),
                    ),
            );
            const isStable = width === previous;
            previous = width;
            return isStable;
        })
        .toBe(true);
    return previous;
}
