import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

/**
 * The active tab's hairline hangs 1px below the tab rail. A rail that could scroll vertically painted the shared 8px
 * scrollbar thumb at its right edge, beside the tabs.
 */
test('the work tab rail never shows a vertical scrollbar', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tab-rail-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        await expect(running.page.getByRole('tab', { name: 'Shell' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        const rails = await running.page
            .locator('[data-tab-scroll-rail]')
            .evaluateAll((elements: HTMLElement[]) =>
                elements.map((rail) => ({
                    overflowY: getComputedStyle(rail).overflowY,
                    scrollbarWidth: rail.offsetWidth - rail.clientWidth,
                })),
            );
        expect(rails.length).toBeGreaterThan(0);
        for (const rail of rails) expect(rail).toEqual({ overflowY: 'hidden', scrollbarWidth: 0 });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
