import type { Locator, Page } from './fixtures.ts';

/**
 * Drops files on the center of `target` the way Finder does. Playwright's drag API moves only in-page drag data, and a
 * `File` built in the page has no disk path, so the drop is dispatched over raw CDP, whose drag data carries real file
 * paths the Renderer resolves exactly as it does for a drag from another application.
 */
export async function dropFinderFiles(
    page: Page,
    target: Locator,
    paths: readonly string[],
): Promise<void> {
    const bounds = await target.boundingBox();
    if (!bounds) throw new Error('The drop target is not visible');
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    /**
     * `dragOperationsMask` 1 offers only Copy, which is what a Finder drag into another app negotiates.
     */
    const data = { items: [], files: [...paths], dragOperationsMask: 1 };
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
        await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
        await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
    } finally {
        await cdp.detach();
    }
}
