import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('sidebar titlebar keeps the drag region without rendering Caxri branding', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-titlebar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const titlebar = running.page.locator('.sidebar-title');
        await expect(titlebar).not.toContainText('Caxri');
        await expect(titlebar.getByRole('button', { name: 'Add Project' })).toBeVisible();
        expect(
            await titlebar.evaluate((element) => ({
                appRegion: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                height: element.getBoundingClientRect().height,
            })),
        ).toEqual({ appRegion: 'drag', height: 44 });
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
