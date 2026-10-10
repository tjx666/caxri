import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, VISIBLE_SESSION } from './support/helpers.ts';

async function runOpenUsage(page: Page): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog');
    await palette.getByPlaceholder('Search projects, sessions, and commands…').fill('open usage');
    await palette.getByText('Open Usage', { exact: true }).click();
}

test('Open Usage asks for a Project first, then opens the Usage tab in the Session pane', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-usage-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        await runOpenUsage(running.page);
        await expect(running.page.getByText('Add a Project to open Usage')).toBeVisible();

        await createProjectSession(running.page, 'shell');
        await runOpenUsage(running.page);
        const usage = running.page.locator(`${VISIBLE_SESSION} [data-usage-page]`);
        await expect(usage.getByRole('heading', { name: 'Usage' })).toBeVisible();
        // A fresh profile has no Agent conversations, so the report settles on the empty state.
        await expect(usage.getByText('No Agent usage yet')).toBeVisible();
        await usage.getByRole('button', { name: '7D' }).click();
        await expect(usage.getByText('No Agent usage yet')).toBeVisible();
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
