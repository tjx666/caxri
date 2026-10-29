import type { Page } from '@playwright/test';

/**
 * The text each find highlight paints, read from the CSS Custom Highlight registry: the matches are static ranges, not
 * elements, so no locator reaches them. A static range has no `toString`, so the same text is selected in a live one.
 */
export async function highlightedText(page: Page, name: string): Promise<string[]> {
    return page.evaluate(
        (highlight) =>
            [...(CSS.highlights.get(highlight) ?? [])].map((abstract) => {
                const range = document.createRange();
                range.setStart(abstract.startContainer, abstract.startOffset);
                range.setEnd(abstract.endContainer, abstract.endOffset);
                return range.toString();
            }),
        name,
    );
}

/**
 * Whether the current find match sits inside the visible Chat's conversation view.
 */
export async function isActiveFindMatchInView(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const view = document.querySelector('.workbench-session:not([hidden]) [role="log"]');
        const abstract = [...(CSS.highlights.get('agent-chat-find-active') ?? [])].at(0);
        if (!view || !abstract) return false;
        const range = document.createRange();
        range.setStart(abstract.startContainer, abstract.startOffset);
        range.setEnd(abstract.endContainer, abstract.endOffset);
        const rect = range.getBoundingClientRect();
        const box = view.getBoundingClientRect();
        return rect.top >= box.top && rect.bottom <= box.bottom;
    });
}
