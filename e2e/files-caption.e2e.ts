import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { closeAppQuietly, createProjectSession, launchCaxri } from './support/helpers.ts';

test('Files caption names the Project, shows its root path, and keeps its actions visible', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-files-caption-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const caption = running.page.locator('.panel-caption');
        const captionTitle = caption.locator('.panel-caption-title');
        const fileActionNames = ['New File', 'New Folder', 'Refresh Files', 'Collapse Folders'];
        await expect(captionTitle).toHaveText('project');
        // The full root path rides the shared Tooltip rather than a native `title`, so keyboard focus can raise it too.
        await captionTitle.hover();
        await expect(running.page.locator('.tooltip-popup[data-open]')).toHaveText(
            await realpath(root),
        );
        await Promise.all(
            fileActionNames.map((name) =>
                expect(caption.getByRole('button', { name })).toHaveCSS('opacity', '1'),
            ),
        );
        await running.page.mouse.move(500, 300);
        await Promise.all(
            fileActionNames.map((name) =>
                expect(caption.getByRole('button', { name })).toHaveCSS('opacity', '1'),
            ),
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
