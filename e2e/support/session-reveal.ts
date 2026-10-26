import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Horizontal tolerance for aligning the reveal label with a Session title; subpixel layout differs by display.
 */
const ALIGNMENT_TOLERANCE_PX = 1;

/**
 * Asserts that a sidebar `Show more` reveal row is a compact, content-width button rather than a full-width row. A
 * full-width button painted its hover background across the whole sidebar and read as a selected Session row (issue
 * #2585), so the button box must stay well short of the Session row and its label must start at the Session title's
 * left edge.
 */
export async function expectCompactSessionReveal(
    reveal: Locator,
    sessionCard: Locator,
): Promise<void> {
    const revealBox = await reveal.boundingBox();
    const cardBox = await sessionCard.boundingBox();
    if (!revealBox || !cardBox) throw new Error('reveal row or Session card is not rendered');
    expect(revealBox.width).toBeLessThan(cardBox.width / 2);
    // A single line: the button keeps its own short height instead of wrapping a long localized label.
    expect(revealBox.height).toBeLessThanOrEqual(24);

    const labelLeft = await reveal.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().left;
    });
    const titleBox = await sessionCard.locator('.session-title').boundingBox();
    if (!titleBox) throw new Error('Session card has no title');
    expect(Math.abs(labelLeft - titleBox.x)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
}
