import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

async function loggedWindowMode(userDataDirectory: string): Promise<string | undefined> {
    const records = (await readFile(join(userDataDirectory, 'logs', 'desktop.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
            (line) =>
                JSON.parse(line) as {
                    event: string;
                    fields?: { windowMode?: string };
                },
        );
    return records.find((record) => record.event === 'e2e.launch')?.fields?.windowMode;
}

test('focused E2E keeps every Electron window hidden while the Renderer stays usable', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-window-mode-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows().map((window) => window.isVisible()),
                ),
            )
            .toEqual([false]);
        await expect.poll(() => loggedWindowMode(userData)).toBe('hidden');
        await createShellSession(running.page);
        expect((await running.page.screenshot()).byteLength).toBeGreaterThan(0);

        await running.page
            .getByRole('button', { name: /^Open Process Explorer, Terminal memory:/ })
            .click();
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((page) => page !== running.page)!;
        await expect(
            processPage.getByText('Process Explorer - Caxri', { exact: true }),
        ).toBeVisible();
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows().map((window) => window.isVisible()),
                ),
            )
            .toEqual([false, false]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('desktop E2E can explicitly show the native window', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-visible-window-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });
    try {
        await expect
            .poll(() =>
                running.app.evaluate(
                    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
                ),
            )
            .toBe(true);
        await expect.poll(() => loggedWindowMode(userData)).toBe('visible');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
