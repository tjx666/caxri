import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { closeAppQuietly, createProjectSession, launchCaxri } from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a document label longer than the whole tab bar truncates so its close button stays in view', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-tab-long-label-'));
    const testDirectory = await realpath(created);
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const name = `${'a-very-long-document-name-'.repeat(9)}end.ts`;
    await writeFile(join(root, name), '', 'utf8');

    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        await page.getByRole('treeitem', { name, exact: true }).dblclick();
        const tab = page.locator('.work-tabs .work-tab:not([data-terminal-id])');
        await expect(tab).toHaveCount(1);
        await expect(tab.getByRole('button', { name: 'Close Editor' })).toBeInViewport({
            ratio: 1,
        });
        const label = tab.locator('.tab-label');
        expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            true,
        );
        // The Terminal's sticky rail sizes to its own tabs, so it must keep them visible beside the document.
        const terminalTab = page.locator('.work-tabs .work-tab[data-terminal-id]').first();
        const terminalBox = await terminalTab.boundingBox();
        const documentBox = await tab.boundingBox();
        expect(terminalBox?.width ?? 0).toBeGreaterThan(40);
        expect((terminalBox?.x ?? 0) + (terminalBox?.width ?? 0)).toBeLessThanOrEqual(
            (documentBox?.x ?? 0) + 1,
        );
        await page.screenshot({ path: testInfo.outputPath('long-tab-label.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
